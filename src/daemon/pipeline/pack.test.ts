/**
 * Declarative pack loader + create-from-pack. Packs are DATA on disk (pack.yaml
 * + role files + constitution) — these tests write real fixture dirs, load them,
 * and run a pack-defined pipeline end-to-end, plus every fail-fast path.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineManager } from "./manager";
import { loadPack } from "./pack";
import { PipelineStore } from "./store";

const tenant = { accountId: "acct", projectId: "proj", createdBy: "user" };

const EXPLORER_ROLE = `name: explorer
summary: read-only scout
write: false
network: read-only
envelope: [read, grep, glob, bash]
`;
const IMPLEMENTER_ROLE = `name: implementer
write: true
network: read-only
envelope: all
`;
const ETHOS = "# Ethos\nDo good work.\n";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Write a pack directory: pack.yaml + optional roles/ + ETHOS.md. */
function writePack(
  manifest: string,
  opts: { roles?: Record<string, string>; ethos?: string } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-pack-"));
  dirs.push(dir);
  writeFileSync(join(dir, "pack.yaml"), manifest);
  if (opts.roles) {
    mkdirSync(join(dir, "roles"), { recursive: true });
    for (const [f, body] of Object.entries(opts.roles)) writeFileSync(join(dir, "roles", f), body);
  }
  if (opts.ethos) writeFileSync(join(dir, "ETHOS.md"), opts.ethos);
  return dir;
}

const FULL_MANIFEST = `schema: codeoid/pack@v1
id: aif-test
name: AIF Test
version: 1.2.3
description: fixture pack
constitution: ./ETHOS.md
roles:
  - ./roles/explorer.yaml
  - ./roles/implementer.yaml
skills:
  - id: spec
    kind: slash
    command: /spec
  - id: build
    kind: prompt
    template: Build it well.
gates:
  - id: tests_pass
    kind: command
    run: "true"
    at: exit
phases:
  - id: explore
    kind: skill
    skill: spec
    role: explorer
  - id: implement
    kind: skill
    skill: build
    role: implementer
    gate: tests_pass
    onFail:
      retry: 2
`;

function fullPack(): string {
  return writePack(FULL_MANIFEST, {
    roles: { "explorer.yaml": EXPLORER_ROLE, "implementer.yaml": IMPLEMENTER_ROLE },
    ethos: ETHOS,
  });
}

describe("loadPack", () => {
  test("parses manifest, roles, constitution, and compiles the pipeline", () => {
    const pack = loadPack(fullPack());
    expect(pack.id).toBe("aif-test");
    expect(pack.name).toBe("AIF Test");
    expect(pack.version).toBe("1.2.3");
    expect(pack.description).toBe("fixture pack");
    expect(pack.constitution).toContain("Do good work");

    expect(Object.keys(pack.roles).sort()).toEqual(["explorer", "implementer"]);
    expect(pack.roles.explorer).toMatchObject({ write: false, network: "read-only" });
    expect(pack.roles.explorer.envelope).toEqual(["read", "grep", "glob", "bash"]);
    expect(pack.roles.implementer).toMatchObject({ write: true, envelope: "all" });

    expect(pack.pipeline).toHaveLength(2);
    expect(pack.pipeline[0]).toMatchObject({ id: "explore", kind: "skill", skill: "spec", role: "explorer" });
    expect(pack.pipeline[1]).toMatchObject({ id: "implement", gate: "tests_pass", role: "implementer" });
    // pack `retry: 2` → 2 retries → 3 total attempts (engine `max` is total).
    expect(pack.pipeline[1].onFail).toEqual({ action: "retry", max: 3 });
  });

  test("register() installs the pack's skills + gates into the registries", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(fullPack()));
    expect(mgr.registries.skills.has("spec")).toBe(true);
    expect(mgr.registries.skills.has("build")).toBe(true);
    expect(mgr.registries.gates.has("tests_pass")).toBe(true);
    expect(mgr.registries.packs.has("aif-test")).toBe(true);
  });

  test("kind defaults to 'skill' when a phase declares only a skill", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
skills:
  - id: s
    kind: slash
    command: /s
phases:
  - id: only
    skill: s
`);
    expect(loadPack(dir).pipeline[0]).toMatchObject({ id: "only", kind: "skill", skill: "s" });
  });

  test("throws when pack.yaml is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-pack-"));
    dirs.push(dir);
    expect(() => loadPack(dir)).toThrow("cannot read pack.yaml");
  });

  test("throws on a wrong schema literal", () => {
    const dir = writePack(`schema: nope/v9
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("invalid pack.yaml");
  });

  test("throws on a phase referencing an unknown skill", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: skill
    skill: ghost
`);
    expect(() => loadPack(dir)).toThrow('unknown skill "ghost"');
  });

  test("throws on a phase referencing an unknown role", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: noop
    role: nobody
`);
    expect(() => loadPack(dir)).toThrow('unknown role "nobody"');
  });

  test("throws on duplicate phase ids", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    kind: noop
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("duplicate phase id");
  });

  test("rejects a constitution path that escapes the pack dir (traversal)", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
constitution: ../../../../etc/passwd
phases:
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("escapes the pack directory");
  });

  test("rejects a symlinked file that escapes the pack dir (symlink confinement)", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
constitution: ./leak.md
phases:
  - id: a
    kind: noop
`);
    // A secret outside the pack, and a symlink INSIDE the pack pointing at it —
    // lexically the path is under the pack dir, so only realpath catches it.
    const outside = mkdtempSync(join(tmpdir(), "codeoid-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "TOP SECRET");
    symlinkSync(join(outside, "secret.md"), join(dir, "leak.md"));
    expect(() => loadPack(dir)).toThrow("escapes the pack directory");
  });

  test("rejects an absolute role path (arbitrary file read)", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
roles:
  - /etc/passwd
phases:
  - id: a
    kind: noop
`);
    expect(() => loadPack(dir)).toThrow("escapes the pack directory");
  });

  test("throws when a phase has neither kind nor skill", () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: p
name: P
version: 0.1.0
phases:
  - id: a
    role: explorer
`);
    expect(() => loadPack(dir)).toThrow("needs a kind or a skill");
  });
});

describe("create({ pack })", () => {
  function noopPack(gateBody: string, phaseGate: string): string {
    return writePack(`schema: codeoid/pack@v1
id: noop-pack
name: Noop
version: 0.0.1
gates:
${gateBody}
phases:
  - id: a
    kind: noop
    gate: ${phaseGate}
  - id: b
    kind: noop
    gate: always
`);
  }

  test("walks a pack-defined pipeline: halts at each boundary, approving each reaches done", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(noopPack('  - id: green\n    kind: command\n    run: "true"', "green"), { trusted: true }));
    const p = mgr.create({ name: "run", pack: "noop-pack", ...tenant });
    expect(p.status).toBe("draft");
    expect(p.phases.map((ph) => ph.def.id)).toEqual(["a", "b"]);
    // Phase "a" runs, its command gate passes, then it HALTS for human review
    // (a passing gate does not auto-advance).
    let s = await mgr.advance(p.id);
    expect(s.status).toBe("halted");
    expect(s.cursor).toBe(0);
    let st = s.phases[s.cursor].state;
    if (st.status !== "halted") throw new Error("expected halt at phase a");
    // Approve → phase "b" runs + halts.
    s = await mgr.answer(p.id, st.requestId, { approved: true });
    expect(s.status).toBe("halted");
    expect(s.cursor).toBe(1);
    st = s.phases[s.cursor].state;
    if (st.status !== "halted") throw new Error("expected halt at phase b");
    // Approve the last boundary → done.
    s = await mgr.answer(p.id, st.requestId, { approved: true });
    expect(s.status).toBe("done");
    expect(s.phases.every((ph) => ph.state.status === "passed")).toBe(true);
  });

  test("a failing trusted command gate halts the pipeline with the gate reason", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(noopPack('  - id: red\n    kind: command\n    run: "false"', "red"), { trusted: true }));
    const p = mgr.create({ name: "run", pack: "noop-pack", ...tenant });
    const halted = await mgr.advance(p.id);
    expect(halted.status).toBe("halted");
    expect(halted.phases[0].state.status).toBe("halted");
    if (halted.phases[0].state.status === "halted") {
      expect(halted.phases[0].state.reason).toContain("command gate");
    }
  });

  test("an UNTRUSTED command gate never executes — fails closed (registry default)", async () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    // No { trusted } → default false. Even a "true" command must not run.
    mgr.installPack(loadPack(noopPack('  - id: green\n    kind: command\n    run: "true"', "green")));
    const p = mgr.create({ name: "run", pack: "noop-pack", ...tenant });
    const halted = await mgr.advance(p.id);
    expect(halted.status).toBe("halted");
    if (halted.phases[0].state.status === "halted") {
      expect(halted.phases[0].state.reason).toContain("requires a trusted pack");
    }
  });

  test("a self/skill/review gate carries no automated verdict — the phase halts for human review (no 'not yet enforced')", async () => {
    const dir = writePack(`schema: codeoid/pack@v1
id: self-pack
name: Self
version: 0.0.1
gates:
  - id: reflect
    kind: self
phases:
  - id: a
    kind: noop
    gate: reflect
`);
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(dir));
    const p = mgr.create({ name: "run", pack: "self-pack", ...tenant });
    const halted = await mgr.advance(p.id);
    expect(halted.status).toBe("halted");
    const st = halted.phases[0].state;
    expect(st.status).toBe("halted");
    if (st.status === "halted") {
      // No fake "not yet enforced" fail-closed halt — a clean human-review boundary.
      expect(st.reason).not.toContain("not yet enforced");
      expect(st.reason).toContain("review and approve");
    }
  });

  test("throws on an unknown pack id", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    expect(() => mgr.create({ name: "x", pack: "ghost", ...tenant })).toThrow("unknown pack");
  });

  test("throws when both phases and pack are given", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    mgr.installPack(loadPack(fullPack()));
    expect(() =>
      mgr.create({ name: "x", pack: "aif-test", phases: [{ id: "one", kind: "noop" }], ...tenant }),
    ).toThrow("either");
  });

  test("throws when neither phases nor pack is given", () => {
    const mgr = new PipelineManager(new PipelineStore(new Database(":memory:")));
    expect(() => mgr.create({ name: "x", ...tenant })).toThrow("provide");
  });
});
