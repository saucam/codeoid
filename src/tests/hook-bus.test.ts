/**
 * HookBus unit tests — command + webhook kinds, offline and deterministic.
 *
 * Command hooks use inline `/bin/sh -c` scripts (printf JSON, exit codes,
 * env/stdin dumps to temp files) so no fixture binaries are needed.
 * Webhook hooks run against a local Bun.serve on an ephemeral port.
 *
 * Coverage:
 *   - block via exit 0 + {"decision":"block"} and via exit code 2 + stderr
 *   - input mutation chains across hooks; block short-circuits
 *   - fail-open on: nonzero (non-2) exit, malformed JSON, timeout,
 *     webhook non-2xx, webhook network error
 *   - matcher regex gates tool_call/tool_result dispatch
 *   - env hardening: hook commands get the built env (no CODEOID_ or
 *     ZEROID_ leak), payload arrives on stdin
 *   - before_turn appends concatenate; tool_result output patch
 *   - emit() fire-and-forget reaches the hook
 *   - createHookBus gating (disabled / empty / populated)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookBus, createHookBus } from "../daemon/hooks/bus.js";
import type { HookEntryConfig, HookSessionContext } from "../daemon/hooks/types.js";
import type { CodeoidConfig } from "../config.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-hooks-"));
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

function ctx(): HookSessionContext {
  return {
    sessionId: "s-1",
    sessionName: "hooks-test",
    workdir: tmp,
    providerId: "mock",
  };
}

function commandEntry(
  command: string,
  overrides: Partial<HookEntryConfig> = {},
): HookEntryConfig {
  return { event: "tool_call", type: "command", command, ...overrides };
}

/** Poll until `path` exists (fire-and-forget emit tests). */
async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`file never appeared: ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("HookBus — command hooks", () => {
  it("blocks via exit 0 + decision JSON", async () => {
    const bus = new HookBus([
      commandEntry(`printf '{"decision":"block","reason":"policy says no"}'`, {
        name: "no-writes",
      }),
    ]);
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Write",
      toolId: "t1",
      input: { file_path: ".env" },
    });
    expect(result.blocked).toEqual({ reason: "policy says no", hookName: "no-writes" });
  });

  it("blocks via exit code 2 with stderr as the reason", async () => {
    const bus = new HookBus([commandEntry(`echo "nope from stderr" >&2; exit 2`)]);
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Bash",
      toolId: "t1",
      input: { command: "rm -rf /" },
    });
    expect(result.blocked?.reason).toBe("nope from stderr");
  });

  it("mutates input, chaining across hooks in declaration order", async () => {
    const bus = new HookBus([
      commandEntry(`printf '{"updatedInput":{"file_path":"/step-one"}}'`, { name: "h1" }),
      // The second hook sees the FIRST hook's mutation on stdin.
      commandEntry(
        `cat > "${tmp}/second-stdin.json"; printf '{"updatedInput":{"file_path":"/step-two"}}'`,
        { name: "h2" },
      ),
    ]);
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Read",
      toolId: "t1",
      input: { file_path: "/original" },
    });
    expect(result.blocked).toBeUndefined();
    expect(result.updatedInput).toEqual({ file_path: "/step-two" });
    expect(result.mutatedBy).toEqual(["h1", "h2"]);
    const secondPayload = JSON.parse(readFileSync(join(tmp, "second-stdin.json"), "utf8"));
    expect(secondPayload.input).toEqual({ file_path: "/step-one" });
  });

  it("block short-circuits later hooks", async () => {
    const bus = new HookBus([
      commandEntry(`printf '{"decision":"block","reason":"first"}'`, { name: "blocker" }),
      commandEntry(`touch "${tmp}/second-ran"`, { name: "later" }),
    ]);
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Bash",
      toolId: "t1",
      input: {},
    });
    expect(result.blocked?.hookName).toBe("blocker");
    // Give any (incorrect) second dispatch a moment to run before asserting.
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(join(tmp, "second-ran"))).toBe(false);
  });

  it("fails open on nonzero (non-2) exit, malformed JSON, and timeout", async () => {
    const bus = new HookBus([
      commandEntry(`echo "crashed" >&2; exit 1`, { name: "crasher" }),
      commandEntry(`printf '{not json'`, { name: "garbled" }),
      commandEntry("sleep 30", { name: "slowpoke", timeoutMs: 150 }),
    ]);
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Bash",
      toolId: "t1",
      input: { command: "ls" },
    });
    expect(result.blocked).toBeUndefined();
    expect(result.updatedInput).toBeUndefined();
  });

  it("passes the hardened env — no daemon secrets, payload on stdin", async () => {
    const envFile = join(tmp, "env-dump");
    const stdinFile = join(tmp, "stdin-dump");
    const bus = new HookBus(
      [commandEntry(`env > "${envFile}"; cat > "${stdinFile}"`)],
      {
        env: {
          PATH: process.env.PATH,
          HOME: "/home/hook-test",
          CODEOID_API_KEY: "zeroid-root-key-DO-NOT-LEAK",
          ZEROID_URL: "https://auth.example",
          TELEGRAM_BOT_TOKEN: "tg-secret",
          RANDOM_OTHER: "not-allowlisted",
        },
      },
    );
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Bash",
      toolId: "t1",
      input: { command: "ls" },
    });
    expect(result.blocked).toBeUndefined();
    const env = readFileSync(envFile, "utf8");
    expect(env).toContain("HOME=/home/hook-test");
    expect(env).not.toContain("CODEOID_API_KEY");
    expect(env).not.toContain("zeroid-root-key");
    expect(env).not.toContain("ZEROID_URL");
    expect(env).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(env).not.toContain("RANDOM_OTHER");
    const payload = JSON.parse(readFileSync(stdinFile, "utf8"));
    expect(payload).toMatchObject({
      event: "tool_call",
      toolName: "Bash",
      toolId: "t1",
      input: { command: "ls" },
      sessionId: "s-1",
      sessionName: "hooks-test",
      workdir: tmp,
      providerId: "mock",
    });
  });

  it("matcher regex gates dispatch by tool name", async () => {
    const bus = new HookBus([
      commandEntry(`printf '{"decision":"block","reason":"no bash"}'`, {
        matcher: "^Bash$",
      }),
    ]);
    expect(bus.hasHooks("tool_call", "Bash")).toBe(true);
    expect(bus.hasHooks("tool_call", "Read")).toBe(false);
    // A matcher entry never fires when the tool name is unknown.
    expect(bus.hasHooks("tool_call")).toBe(false);

    const read = await bus.dispatchToolCall(ctx(), {
      toolName: "Read",
      toolId: "t1",
      input: {},
    });
    expect(read.blocked).toBeUndefined();
    const bash = await bus.dispatchToolCall(ctx(), {
      toolName: "Bash",
      toolId: "t2",
      input: {},
    });
    expect(bash.blocked?.reason).toBe("no bash");
  });

  it("skips entries with invalid matchers instead of matching everything", () => {
    const bus = new HookBus([
      commandEntry(`printf '{"decision":"block"}'`, { matcher: "([unclosed" }),
    ]);
    expect(bus.size).toBe(0);
    expect(bus.hasHooks("tool_call", "Bash")).toBe(false);
  });

  it("before_turn appends concatenate in declaration order", async () => {
    const bus = new HookBus([
      commandEntry(`printf '{"systemPromptAppend":"rule one"}'`, { event: "before_turn" }),
      commandEntry(`printf '{"systemPromptAppend":"rule two"}'`, { event: "before_turn" }),
    ]);
    const result = await bus.dispatchBeforeTurn(ctx(), { prompt: "hello" });
    expect(result.systemPromptAppend).toBe("rule one\n\nrule two");
  });

  it("tool_result hooks patch the recorded output", async () => {
    const bus = new HookBus([
      commandEntry(`printf '{"updatedOutput":"[REDACTED]"}'`, {
        event: "tool_result",
        matcher: "^Read$",
      }),
    ]);
    const patched = await bus.dispatchToolResult(ctx(), {
      toolName: "Read",
      output: "AWS_SECRET=hunter2",
      success: true,
    });
    expect(patched.updatedOutput).toBe("[REDACTED]");
    const untouched = await bus.dispatchToolResult(ctx(), {
      toolName: "Bash",
      output: "ok",
      success: true,
    });
    expect(untouched.updatedOutput).toBeUndefined();
  });

  it("emit() fires observe hooks without blocking the caller", async () => {
    const marker = join(tmp, "after-turn-ran");
    const bus = new HookBus([
      commandEntry(`cat > "${marker}"`, { event: "after_turn" }),
    ]);
    bus.emit("after_turn", ctx(), { result: { model: "mock-model" } });
    await waitForFile(marker);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.event).toBe("after_turn");
    expect(payload.result).toEqual({ model: "mock-model" });
  });
});

describe("HookBus — webhook hooks", () => {
  it("honors block + mutate outcomes from a 2xx JSON body and fails open otherwise", async () => {
    const seen: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen.push(await req.json());
        if (url.pathname === "/block") {
          return Response.json({ decision: "block", reason: "webhook says no" });
        }
        if (url.pathname === "/mutate") {
          return Response.json({ updatedInput: { file_path: "/from-webhook" } });
        }
        return new Response("boom", { status: 500 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const mk = (url: string): HookBus =>
        new HookBus([{ event: "tool_call", type: "webhook", url }]);

      const blocked = await mk(`${base}/block`).dispatchToolCall(ctx(), {
        toolName: "Write",
        toolId: "t1",
        input: { file_path: "x" },
      });
      expect(blocked.blocked?.reason).toBe("webhook says no");
      expect(seen[0]).toMatchObject({ event: "tool_call", toolName: "Write" });

      const mutated = await mk(`${base}/mutate`).dispatchToolCall(ctx(), {
        toolName: "Write",
        toolId: "t2",
        input: { file_path: "x" },
      });
      expect(mutated.updatedInput).toEqual({ file_path: "/from-webhook" });

      // Non-2xx → fail-open.
      const failed = await mk(`${base}/oops`).dispatchToolCall(ctx(), {
        toolName: "Write",
        toolId: "t3",
        input: { file_path: "x" },
      });
      expect(failed.blocked).toBeUndefined();
      expect(failed.updatedInput).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  it("fails open when the webhook is unreachable", async () => {
    // Port 1 is reserved/closed — connection refused immediately.
    const bus = new HookBus([
      { event: "tool_call", type: "webhook", url: "http://127.0.0.1:1/hook", timeoutMs: 500 },
    ]);
    const result = await bus.dispatchToolCall(ctx(), {
      toolName: "Bash",
      toolId: "t1",
      input: {},
    });
    expect(result.blocked).toBeUndefined();
  });
});

describe("createHookBus", () => {
  const entry: HookEntryConfig = { event: "tool_call", type: "command", command: "true" };

  it("returns undefined when hooks are absent, disabled, or empty", () => {
    expect(createHookBus(undefined)).toBeUndefined();
    expect(createHookBus({} as CodeoidConfig)).toBeUndefined();
    expect(
      createHookBus({ hooks: { enabled: false, entries: [entry] } } as unknown as CodeoidConfig),
    ).toBeUndefined();
    expect(
      createHookBus({ hooks: { enabled: true, entries: [] } } as unknown as CodeoidConfig),
    ).toBeUndefined();
  });

  it("builds a bus from configured entries", () => {
    const bus = createHookBus({
      hooks: { enabled: true, entries: [entry] },
    } as unknown as CodeoidConfig);
    expect(bus).toBeDefined();
    expect(bus?.size).toBe(1);
    expect(bus?.hasHooks("tool_call", "Bash")).toBe(true);
  });
});
