/**
 * End-to-end runner tests — actually spawn shell commands and verify the
 * compressor handles real process output. Uses tiny/fast commands so the
 * suite stays under ~100 ms.
 */

import { describe, it, expect } from "bun:test";
import {
  CompressionRegistry,
  BUILTIN_RULES,
  runCompressed,
} from "../daemon/compress/index.js";

function makeRegistry(): CompressionRegistry {
  return new CompressionRegistry({ rules: BUILTIN_RULES });
}

describe("runCompressed — end to end", () => {
  it("captures stdout + stderr + exit code for a successful command", async () => {
    const out = await runCompressed({
      command: `sh -c 'echo hello; echo err 1>&2; exit 0'`,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: makeRegistry(),
      minBytes: 1024,
      compressPipes: false,
    });
    expect(out.stdout).toContain("hello");
    expect(out.stderr).toContain("err");
    expect(out.exitCode).toBe(0);
  });

  it("propagates non-zero exit codes", async () => {
    const out = await runCompressed({
      command: `sh -c 'echo x; exit 3'`,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: makeRegistry(),
      minBytes: 1024,
      compressPipes: false,
    });
    expect(out.stdout).toContain("x");
    expect(out.exitCode).toBe(3);
  });

  it("passes through small outputs (below minBytes)", async () => {
    const out = await runCompressed({
      command: "echo small",
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: makeRegistry(),
      minBytes: 1024,
      compressPipes: false,
    });
    expect(out.ruleName).toBeNull();
    expect(out.ratio).toBe(1);
    expect(out.stdout.trim()).toBe("small");
  });

  it("triggers the generic truncator on a large dump", async () => {
    // Produce ~2000 lines = well over 4 KB.
    const cmd = `sh -c 'for i in $(seq 1 2000); do echo "line_$i"; done'`;
    const out = await runCompressed({
      command: cmd,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: makeRegistry(),
      minBytes: 1024,
      compressPipes: false,
    });
    expect(out.ruleName).toBe("generic-head-tail");
    expect(out.stdout).toContain("lines omitted");
    expect(out.stdout).toContain("line_1");
    expect(out.stdout).toContain("line_2000");
    expect(out.ratio).toBeLessThan(0.5);
    // Footer hint must be present.
    expect(out.stdout).toContain("[codeoid:");
  });

  it("bypasses compression for piped commands when compressPipes=false", async () => {
    const cmd = `sh -c 'for i in $(seq 1 200); do echo "line_$i"; done' | head -50`;
    const out = await runCompressed({
      command: cmd,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: makeRegistry(),
      minBytes: 50,
      compressPipes: false,
    });
    // Pipe detection blocks compression; ratio = 1.
    expect(out.ruleName).toBeNull();
    expect(out.ratio).toBe(1);
  });

  it("honors excludeCommands", async () => {
    const reg = new CompressionRegistry({
      rules: BUILTIN_RULES,
      excludeCommands: ["seq"],
    });
    const cmd = "seq 1 2000";
    const out = await runCompressed({
      command: cmd,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: reg,
      minBytes: 1024,
      compressPipes: false,
    });
    expect(out.ruleName).toBeNull();
    // Raw seq output is >4KB but registry excluded it.
    expect(out.originalBytes).toBeGreaterThan(4000);
    expect(out.ratio).toBe(1);
  });

  it("stderr is NEVER compressed — error fidelity matters", async () => {
    const cmd = `sh -c 'for i in $(seq 1 100); do echo "err_$i" 1>&2; done; exit 1'`;
    const out = await runCompressed({
      command: cmd,
      workdir: "/tmp",
      env: process.env as Record<string, string>,
      registry: makeRegistry(),
      minBytes: 100,
      compressPipes: false,
    });
    // All 100 stderr lines must survive.
    for (let i = 1; i <= 100; i++) {
      expect(out.stderr).toContain(`err_${i}`);
    }
  });
});
