/**
 * PackService — dynamic pack loading (docs/pack-loading.md). Uses temp dirs +
 * an injected fake git (no network / no real clone) + a fake pack registry sink,
 * so the fetch → discover → install → trust → select → remove lifecycle is
 * exercised end to end without a daemon or a real repo.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pack } from "./interface";
import { PackService, registryNameFromUrl, type PackServiceConfig } from "./pack-service";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "packsvc-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a valid pack directory (pack.yaml + one role + ETHOS). */
function writePack(dir: string, id: string, opts: { withCommandGate?: boolean } = {}): void {
  mkdirSync(join(dir, "roles"), { recursive: true });
  writeFileSync(join(dir, "ETHOS.md"), "Be good.");
  writeFileSync(
    join(dir, "roles", "implementer.yaml"),
    "name: implementer\nwrite: true\nnetwork: read-only\nenvelope: all\n",
  );
  const gate = opts.withCommandGate
    ? 'gates:\n  - { id: tests, kind: command, run: "true", at: exit }\n'
    : "";
  const gateRef = opts.withCommandGate ? " gate: tests" : "";
  writeFileSync(
    join(dir, "pack.yaml"),
    `schema: codeoid/pack@v1
id: ${id}
name: Pack ${id}
version: 1.0.0
description: a test pack
constitution: ./ETHOS.md
roles: [./roles/implementer.yaml]
skills:
  - { id: build, kind: prompt, template: "build it" }
${gate}phases:
  - { id: impl, kind: skill, skill: build, role: implementer${gateRef} }
`,
  );
}

/** A registry cache layout: <root>/.git + <root>/packs/<id>/ + <root>/skills/<s>/ */
function writeRegistry(root: string, packIds: string[], skills: string[] = []): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const id of packIds) writePack(join(root, "packs", id), id);
  for (const s of skills) {
    mkdirSync(join(root, "skills", s), { recursive: true });
    writeFileSync(join(root, "skills", s, "SKILL.md"), `# ${s}`);
  }
}

/** A fake pipeline registry sink capturing installPack/unregister. */
function fakeSink() {
  const packs = new Map<string, Pack>();
  return {
    installPack: (p: Pack) => packs.set(p.id, p),
    registries: {
      packs: {
        unregister: (id: string) => packs.delete(id),
        has: (id: string) => packs.has(id),
      },
    },
    _packs: packs,
  };
}

/** Build a PackService with a captured config + a fake git that "clones" by
 *  copying a prepared fixture registry into the cache. */
function makeService(opts: {
  cacheDir: string;
  skillsDir?: string;
  fixture?: string; // a prepared registry dir the fake `git clone` copies in
  sink?: ReturnType<typeof fakeSink>;
  initial?: Partial<PackServiceConfig>;
}) {
  const persisted: PackServiceConfig[] = [];
  const svc = new PackService({
    config: {
      defaultPack: opts.initial?.defaultPack ?? null,
      packs: opts.initial?.packs ?? [],
      registries: opts.initial?.registries ?? [],
    },
    cacheDir: opts.cacheDir,
    skillsDir: opts.skillsDir,
    manager: opts.sink ? () => opts.sink! : undefined,
    persist: (s) => persisted.push(structuredClone(s)),
    git: async (args, _cwd) => {
      if (args[0] === "clone" && opts.fixture) {
        const dest = args[args.length - 1]!;
        // Emulate a clone by copying the fixture tree into the target.
        cpDir(opts.fixture, dest);
        return { ok: true, stderr: "" };
      }
      if (args[0] === "pull") return { ok: true, stderr: "" };
      return { ok: false, stderr: `unexpected git ${args.join(" ")}` };
    },
  });
  return { svc, persisted };
}

function cpDir(from: string, to: string): void {
  const { cpSync } = require("node:fs");
  cpSync(from, to, { recursive: true });
}

describe("registryNameFromUrl", () => {
  test("derives a name from ssh + https + trailing forms", () => {
    expect(registryNameFromUrl("git@github.com:highflame-ai/ai-factory.git")).toBe("ai-factory");
    expect(registryNameFromUrl("https://github.com/highflame-ai/ai-factory.git")).toBe("ai-factory");
    expect(registryNameFromUrl("https://github.com/x/my-registry/")).toBe("my-registry");
  });
});

describe("addRegistry + discovery", () => {
  test("clones into the cache, persists, and lists cached packs", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["aif-sdlc", "other-pack"], ["spec"]);
    const cacheDir = join(tmp(), "cache");
    const { svc, persisted } = makeService({ cacheDir, fixture });

    await svc.addRegistry({ url: "git@github.com:highflame-ai/ai-factory.git" });

    const regs = svc.listRegistries();
    expect(regs).toHaveLength(1);
    expect(regs[0]!.name).toBe("ai-factory");
    expect(regs[0]!.cached).toBe(true);
    expect(regs[0]!.packCount).toBe(2);
    expect(persisted.at(-1)!.registries[0]!.url).toContain("ai-factory");

    const avail = svc.available().sort((a, b) => a.id.localeCompare(b.id));
    expect(avail.map((p) => p.id)).toEqual(["aif-sdlc", "other-pack"]);
    expect(avail[0]!.registry).toBe("ai-factory");
    expect(avail[0]!.installed).toBe(false);
  });

  test("rejects re-adding a name with a different url", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    await expect(svc.addRegistry({ url: "https://github.com/b/reg.git" })).rejects.toThrow(/different url/);
  });

  test("re-adding the same registry pulls (not clone) and doesn't duplicate", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const cacheDir = join(tmp(), "c");
    const { svc } = makeService({ cacheDir, fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    // Second add with the SAME url: the cache exists, so it pulls (fake git
    // returns ok for pull), and the registry list stays length 1.
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    expect(svc.listRegistries()).toHaveLength(1);
  });

  test("refresh pulls a cached registry (and no-ops an uncached one)", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const { svc } = makeService({
      cacheDir: join(tmp(), "c"),
      fixture,
      initial: { registries: [{ name: "reg", url: "https://github.com/a/reg.git" }] },
    });
    // Not cached yet → refresh is a no-op (doesn't throw).
    await svc.refresh("reg");
    // After adding (clone), refresh pulls it.
    await svc.addRegistry({ url: "https://github.com/a/reg.git", name: "reg" });
    await svc.refresh("reg");
    await svc.refresh(); // all
  });
});

describe("install / trust / select / remove", () => {
  test("install from a registry: registers into the manager, persists, links skills", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["aif-sdlc"], ["spec", "review"]);
    const cacheDir = join(tmp(), "cache");
    const skillsDir = join(tmp(), "skills");
    const sink = fakeSink();
    const { svc, persisted } = makeService({ cacheDir, skillsDir, fixture, sink });
    await svc.addRegistry({ url: "https://github.com/highflame-ai/ai-factory.git" });

    const installed = svc.install({ packId: "aif-sdlc", trusted: false });
    const pack = installed.find((p) => p.id === "aif-sdlc")!;
    expect(pack).toBeTruthy();
    expect(pack.trusted).toBe(false);
    expect(pack.active).toBe(true); // registered into the sink
    expect(pack.registry).toBe("ai-factory");
    expect(pack.phases.map((ph) => ph.id)).toEqual(["impl"]);
    expect(pack.roles).toEqual(["implementer"]);
    expect(sink._packs.has("aif-sdlc")).toBe(true);
    // config persisted, and skills linked into the skills dir
    expect(persisted.at(-1)!.packs).toHaveLength(1);
    expect(existsSync(join(skillsDir, "spec"))).toBe(true);
    expect(existsSync(join(skillsDir, "review"))).toBe(true);
    // available() now marks it installed
    expect(svc.available().find((p) => p.id === "aif-sdlc")!.installed).toBe(true);
  });

  test("install from a local dir (no registry)", () => {
    const dir = join(tmp(), "local-pack");
    writePack(dir, "local");
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), sink });
    const installed = svc.install({ dir });
    expect(installed.find((p) => p.id === "local")!.registry).toBeUndefined();
    expect(sink._packs.has("local")).toBe(true);
  });

  test("skill-linking never clobbers an existing skill", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"], ["spec"]);
    const skillsDir = join(tmp(), "skills");
    mkdirSync(join(skillsDir, "spec"), { recursive: true });
    writeFileSync(join(skillsDir, "spec", "SKILL.md"), "PRE-EXISTING");
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), skillsDir, fixture });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    svc.install({ packId: "p" });
    // The pre-existing skill dir is untouched (not a symlink to the registry).
    expect(require("node:fs").readFileSync(join(skillsDir, "spec", "SKILL.md"), "utf8")).toBe("PRE-EXISTING");
  });

  test("trust toggle re-registers at the new trust level", async () => {
    const fixture = tmp();
    writeRegistry(fixture, ["p"]);
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), fixture, sink });
    await svc.addRegistry({ url: "https://github.com/a/reg.git" });
    svc.install({ packId: "p", trusted: false });
    const after = svc.trust("p", true);
    expect(after.find((x) => x.id === "p")!.trusted).toBe(true);
  });

  test("select sets the default pack (and rejects an uninstalled id)", () => {
    const dir = join(tmp(), "p");
    writePack(dir, "sel");
    const { svc, persisted } = makeService({ cacheDir: join(tmp(), "c") });
    svc.install({ dir });
    expect(() => svc.select("nope")).toThrow(/not installed/);
    const after = svc.select("sel");
    expect(after.find((p) => p.id === "sel")!.selected).toBe(true);
    expect(persisted.at(-1)!.defaultPack).toBe("sel");
    expect(svc.selectedPack).toBe("sel");
  });

  test("remove unregisters + drops config + clears selection", () => {
    const dir = join(tmp(), "p");
    writePack(dir, "gone");
    const sink = fakeSink();
    const { svc } = makeService({ cacheDir: join(tmp(), "c"), sink });
    svc.install({ dir });
    svc.select("gone");
    const after = svc.remove("gone");
    expect(after).toHaveLength(0);
    expect(sink._packs.has("gone")).toBe(false);
    expect(svc.selectedPack).toBeNull();
  });

  test("install of an unknown packId throws", () => {
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    expect(() => svc.install({ packId: "ghost" })).toThrow(/not found in any registry/);
  });

  test("install with neither packId nor dir throws", () => {
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    expect(() => svc.install({})).toThrow(/provide `packId` or `dir`/);
  });

  test("trust of an uninstalled pack throws", () => {
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    expect(() => svc.trust("ghost", true)).toThrow(/not installed/);
  });

  test("select(null) clears the default", () => {
    const dir = join(tmp(), "p");
    writePack(dir, "d");
    const { svc } = makeService({ cacheDir: join(tmp(), "c") });
    svc.install({ dir });
    svc.select("d");
    expect(svc.selectedPack).toBe("d");
    svc.select(null);
    expect(svc.selectedPack).toBeNull();
  });
});

describe("installed() resilience", () => {
  test("a broken pack dir surfaces as an error entry, not a throw", () => {
    const dir = join(tmp(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.yaml"), "schema: codeoid/pack@v1\nid: broke\nname: B\nversion: 1.0.0\nphases: []\n");
    // phases: [] violates min(1) → loadPack throws, installed() must not.
    const { svc } = makeService({
      cacheDir: join(tmp(), "c"),
      initial: { packs: [{ dir, trusted: false }] },
    });
    const installed = svc.installed();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.error).toBeTruthy();
    expect(installed[0]!.active).toBe(false);
  });
});
