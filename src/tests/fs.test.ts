/**
 * fs handler tests — entry relativisation, hidden-name filtering, sorting,
 * and symlink-escape rejection. Pins the behavior around the #89 fix: the
 * workdir is canonicalised ONCE per fs.list call (in resolveSafe) instead of
 * once per directory entry, and entry paths stay relative to the canonical
 * root even when the caller hands us a symlinked workdir alias.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { FsAccessError, handleFsList, handleFsRead, isProtectedPath, resolveSafe } from "../daemon/fs.js";
import { getConfigDir } from "../config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-fs-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

describe("resolveSafe", () => {
  it("returns the canonical workdir root alongside the resolved path", async () => {
    mkdirSync(join(tmp, "sub"));
    const r = await resolveSafe(tmp, "sub");
    expect(r.relative).toBe("sub");
    expect(r.absolute).toBe(join(r.workdirRoot, "sub"));
  });

  it("rejects symlink escapes out of the workdir", async () => {
    const outside = mkdtempSync(join(tmpdir(), "codeoid-fs-outside-"));
    try {
      symlinkSync(outside, join(tmp, "escape"));
      await expect(resolveSafe(tmp, "escape")).rejects.toThrow(FsAccessError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── Protected directories (GHSA-38vh vector 2) ────────────────────────────────

describe("protected directories", () => {
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  it("isProtectedPath flags the daemon config dir and host credential dirs", () => {
    process.env.XDG_CONFIG_HOME = join(tmp, "xdg");
    const configDir = getConfigDir(); // <tmp>/xdg/codeoid
    expect(isProtectedPath(join(configDir, "config.json"))).toBe(true);
    expect(isProtectedPath(configDir)).toBe(true);
    expect(isProtectedPath(join(homedir(), ".ssh", "id_rsa"))).toBe(true);
    expect(isProtectedPath(join(homedir(), ".aws", "credentials"))).toBe(true);
    expect(isProtectedPath(join(tmp, "project", "src", "index.ts"))).toBe(false);
  });

  it("resolveSafe refuses a path inside the daemon config dir even from an ancestor workdir", async () => {
    // Point the config dir under our tmp so the test is hermetic, then root a
    // session AT that config home — the exploit's `workdir: "~"` shape.
    const configHome = join(tmp, "xdg");
    process.env.XDG_CONFIG_HOME = configHome;
    const configDir = getConfigDir(); // <configHome>/codeoid
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{"apiKey":"zid_sk_ROOT"}');

    await expect(resolveSafe(configHome, "codeoid/config.json")).rejects.toThrow(
      FsAccessError,
    );
    // fs.read through the same chokepoint is refused too.
    await expect(
      handleFsRead({ id: "r", path: "codeoid/config.json" }, configHome),
    ).rejects.toThrow(FsAccessError);

    // A non-protected sibling under the same workdir still resolves fine.
    writeFileSync(join(configHome, "notes.txt"), "hello");
    const r = await resolveSafe(configHome, "notes.txt");
    expect(r.relative).toBe("notes.txt");
  });
});

describe("handleFsList", () => {
  it("lists entries relative to the workdir, dirs first, hidden names excluded", async () => {
    mkdirSync(join(tmp, "sub"));
    mkdirSync(join(tmp, "node_modules"));
    writeFileSync(join(tmp, "a.txt"), "a");
    writeFileSync(join(tmp, "sub", "b.txt"), "b");

    const res = await handleFsList({ id: "r1", path: "" }, tmp);
    expect(res.entries.map((e) => e.name)).toEqual(["sub", "a.txt"]);
    expect(res.entries[0]!.kind).toBe("directory");
    expect(res.entries[1]!.kind).toBe("file");

    const subRes = await handleFsList({ id: "r2", path: "sub" }, tmp);
    expect(subRes.entries.map((e) => e.path)).toEqual([join("sub", "b.txt")]);
  });

  it("relativises children against the canonical root when the workdir is a symlink", async () => {
    // Some platforms hand out symlinked workdirs (macOS /tmp → /private/tmp).
    // List THROUGH an alias — entry paths must be relative to the canonical
    // root, same as before the per-entry realpath was hoisted.
    const real = join(tmp, "real-root");
    const alias = join(tmp, "alias-root");
    mkdirSync(real);
    writeFileSync(join(real, "f.txt"), "x");
    symlinkSync(real, alias);

    const res = await handleFsList({ id: "r3", path: "" }, alias);
    expect(res.entries.map((e) => e.path)).toEqual(["f.txt"]);
  });
});
