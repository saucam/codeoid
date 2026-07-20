import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseDef } from "./interface";
import { createPipelineManagerFromConfig } from "./wiring";

const phases: PhaseDef[] = [{ id: "one", kind: "noop", gate: "always" }];
const tenant = { accountId: "acct", projectId: "proj", createdBy: "user" };

const dbFiles: string[] = [];
function tmpDb(): string {
  const p = join(tmpdir(), `codeoid-pipeline-${randomUUID()}.db`);
  dbFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of dbFiles.splice(0)) {
    for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  }
});

describe("createPipelineManagerFromConfig", () => {
  test("returns undefined when config is absent", () => {
    expect(createPipelineManagerFromConfig(undefined)).toBeUndefined();
  });

  test("returns undefined when the pipeline is disabled (the default)", () => {
    expect(createPipelineManagerFromConfig({ dbPath: tmpDb() })).toBeUndefined();
    expect(createPipelineManagerFromConfig({ dbPath: tmpDb(), pipeline: { enabled: false } })).toBeUndefined();
  });

  test("returns a manager when enabled", () => {
    const mgr = createPipelineManagerFromConfig({ dbPath: tmpDb(), pipeline: { enabled: true } });
    expect(mgr).toBeDefined();
    const p = mgr?.create({ name: "REQ-1", phases, ...tenant });
    expect(mgr?.get(p?.id ?? "")?.name).toBe("REQ-1");
  });

  test("installs configured packs so create({ pack }) resolves", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeoid-wiring-pack-"));
    mkdirSync(join(dir, "roles"), { recursive: true });
    writeFileSync(join(dir, "roles", "impl.yaml"), "name: impl\nwrite: true\nnetwork: read-only\nenvelope: all\n");
    writeFileSync(
      join(dir, "pack.yaml"),
      `schema: codeoid/pack@v1
id: wpack
name: W
version: 0.0.1
roles: [./roles/impl.yaml]
phases:
  - { id: a, kind: noop, role: impl, gate: always }
`,
    );
    const mgr = createPipelineManagerFromConfig({
      dbPath: tmpDb(),
      pipeline: { enabled: true, packs: [{ dir }] },
    });
    expect(mgr?.registries.packs.has("wpack")).toBe(true);
    const p = mgr?.create({ name: "R", pack: "wpack", ...tenant });
    expect(mgr?.get(p?.id ?? "")?.phases[0].def.role).toBe("impl");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed / missing pack is skipped (fail-soft) — the manager still boots", () => {
    const mgr = createPipelineManagerFromConfig({
      dbPath: tmpDb(),
      pipeline: { enabled: true, packs: [{ dir: "/nonexistent/pack/dir" }] },
    });
    expect(mgr).toBeDefined();
    // The bad pack didn't register, but the manager is usable with explicit phases.
    const p = mgr?.create({ name: "R", phases, ...tenant });
    expect(mgr?.get(p?.id ?? "")?.name).toBe("R");
  });

  test("shares the daemon DB file so a fresh manager resumes (restart survival)", async () => {
    const dbPath = tmpDb();
    const mgr = createPipelineManagerFromConfig({ dbPath, pipeline: { enabled: true } });
    const halting: PhaseDef[] = [{ id: "one", kind: "noop", gate: "manual" }]; // halts
    const p = mgr?.create({ name: "REQ-1", phases: halting, ...tenant });
    expect((await mgr?.advance(p?.id ?? ""))?.status).toBe("halted");

    // Simulate a daemon restart: a brand-new manager over the same DB file.
    const revived = createPipelineManagerFromConfig({ dbPath, pipeline: { enabled: true } });
    expect(revived?.get(p?.id ?? "")?.status).toBe("halted");
  });
});
