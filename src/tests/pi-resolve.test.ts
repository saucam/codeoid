/**
 * pi binary resolution + bundled fallback — offline except the live smoke
 * test, which runs the BUNDLED pi (node_modules, no network) to prove the
 * zero-install path actually executes under the daemon's runtime.
 *
 * Resolution order under test (pi/resolve.ts):
 *   1. explicit `providers.pi.command` (verified, not trusted blindly)
 *   2. system pi on PATH
 *   3. bundled @earendil-works/pi-coding-agent via process.execPath
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_PI_PACKAGE,
  bundledPiEntry,
  resolvePiCommand,
} from "../daemon/providers/pi/resolve.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import type { CodeoidConfig } from "../config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-pi-resolve-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

/** Drop an executable fake pi into `dir` and return its path. */
function fakePi(dir: string, name = "pi"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho fake-pi\n");
  chmodSync(path, 0o755);
  return path;
}

describe("resolvePiCommand", () => {
  it("explicit config path wins when it exists", () => {
    const bin = fakePi(tmp, "my-pi");
    const r = resolvePiCommand(bin, { PATH: "" });
    expect(r).toEqual({ command: bin, argsPrefix: [], source: "config" });
  });

  it("explicit config path that doesn't exist resolves to null (loud at startup)", () => {
    expect(resolvePiCommand(join(tmp, "nope"), { PATH: "" })).toBeNull();
  });

  it("bare-name config override is looked up on PATH", () => {
    fakePi(tmp, "pi-wrapper");
    const r = resolvePiCommand("pi-wrapper", { PATH: tmp });
    expect(r?.source).toBe("config");
    expect(r?.command).toBe(join(tmp, "pi-wrapper"));
  });

  it("system pi on PATH wins over the bundled fallback", () => {
    const bin = fakePi(tmp);
    const r = resolvePiCommand(undefined, { PATH: tmp });
    expect(r).toEqual({ command: bin, argsPrefix: [], source: "path" });
  });

  it("falls back to the bundled package when PATH has no pi", () => {
    const r = resolvePiCommand(undefined, { PATH: "" });
    expect(r?.source).toBe("bundled");
    expect(r?.command).toBe(process.execPath);
    expect(r?.argsPrefix).toHaveLength(1);
    expect(r?.argsPrefix[0]).toEndWith("cli.js");
    expect(r?.argsPrefix[0]).toContain(BUNDLED_PI_PACKAGE.split("/")[1]!);
  });

  it("live smoke: the bundled pi actually runs under the daemon runtime", async () => {
    const entry = bundledPiEntry();
    expect(entry).not.toBeNull();
    const proc = Bun.spawn([process.execPath, entry!, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("registry activation", () => {
  it("registers pi via the bundled fallback with default config", () => {
    // This machine intentionally has no system pi; CI likewise. The
    // registry must still activate pi through the optionalDependency.
    const registry = createDefaultProviderRegistry();
    expect(registry.has("pi")).toBe(true);
    expect(registry.unavailableHint("pi")).toBeUndefined();
  });

  it("marks pi unavailable (with the configured command in the hint) on a bogus override", () => {
    const config = {
      providers: { pi: { enabled: true, command: join(tmp, "definitely-missing") } },
    } as unknown as CodeoidConfig;
    const registry = createDefaultProviderRegistry(config);
    expect(registry.has("pi")).toBe(false);
    expect(registry.unavailableHint("pi")).toContain("definitely-missing");
    expect(registry.unavailableEntries()).toEqual([
      { id: "pi", hint: expect.stringContaining("providers.pi.command") },
    ]);
  });

  it("keeps pi out of the catalog entirely when disabled", () => {
    const config = {
      providers: { pi: { enabled: false, command: "pi" } },
    } as unknown as CodeoidConfig;
    const registry = createDefaultProviderRegistry(config);
    expect(registry.has("pi")).toBe(false);
    expect(registry.unavailableHint("pi")).toBeUndefined();
  });
});
