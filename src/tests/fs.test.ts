/**
 * fs handler tests — entry relativisation, hidden-name filtering, sorting,
 * and symlink-escape rejection. Pins the behavior around the #89 fix: the
 * workdir is canonicalised ONCE per fs.list call (in resolveSafe) instead of
 * once per directory entry, and entry paths stay relative to the canonical
 * root even when the caller hands us a symlinked workdir alias.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsAccessError, handleFsList, resolveSafe } from "../daemon/fs.js";

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
