/**
 * CodexProvider tests — offline over the fake-codex fixture (newline
 * JSON-RPC subprocess, same pattern as fake-pi).
 *
 *   C1  text turn: thinking + text deltas, text_done, turn_done with usage
 *   C2  approval APPROVED: server request → tool_start → canUseTool(Bash,
 *       command input) → fixture sees "approved" → tool_complete
 *   C3  approval DENIED: decision "denied" reaches codex; no tool_complete
 *   C4  non-gated item: retrospective tool_start/tool_complete pair
 *   C5  seedFromHistory: first prompt carries the structured transcript
 *   C6  requestUserInput: select question round-trips the picked option
 *   C7  missing binary surfaces a clear error
 *   C8  model/list maps to ModelInfo
 *   C9  resolveCodexCommand: config → PATH → null (+ registry hint)
 */

import { describe, it, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpcProcess } from "../daemon/providers/codex/rpc.js";
import { CodexProvider } from "../daemon/providers/codex/index.js";
import { compareNodeVersionsDesc, resolveCodexCommand } from "../daemon/providers/codex/resolve.js";
import { createDefaultProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import type { CodeoidConfig } from "../config.js";
import type { Store } from "../daemon/store.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-codex.ts");

function makeProvider(command = process.execPath, argsPrefix = [FIXTURE]): CodexProvider {
  return new CodexProvider({
    sessionId: "sess-1",
    initialBackingId: "sess-1", // first run — provider starts a fresh thread
    command,
    argsPrefix,
    store: {} as Store, // not consulted in this slice
  });
}

function turnOpts(
  userMessage: string,
  overrides: Partial<TurnOpts> = {},
): TurnOpts {
  return {
    history: [],
    userMessage,
    workdir: "/tmp",
    canUseTool: async () => ({ behavior: "allow" as const }),
    ...overrides,
  };
}

async function collect(run: TurnRun): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
    if (event.type === "turn_done" || event.type === "error") break;
  }
  return events;
}

describe("CodexProvider over fake-codex", () => {
  it("C1: text turn streams thinking + text and completes with usage", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("hello")));
    await p.teardown();

    expect(events.some((e) => e.type === "thinking_delta" && e.content === "thinking...")).toBe(true);
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e as { content: string }).content);
    expect(deltas.join("")).toBe("Hello world");
    const done = events.find((e) => e.type === "text_done");
    expect(done && (done as { content: string }).content).toBe("Hello world");
    const turnDone = events.find((e) => e.type === "turn_done");
    expect(turnDone).toBeDefined();
    if (turnDone?.type === "turn_done") {
      expect(turnDone.result.providerId).toBe("codex");
      // Usage comes from thread/tokenUsage/updated (turn/completed has none);
      // inputTokens excludes cache reads (claude convention): 120 - 20.
      expect(turnDone.result.inputTokens).toBe(100);
      expect(turnDone.result.outputTokens).toBe(45);
      expect(turnDone.result.cacheReadTokens).toBe(20);
    }
  });

  it("C2: approval request routes through canUseTool and approval runs the item", async () => {
    const p = makeProvider();
    const gated: Array<{ name: string; input: Record<string, unknown> }> = [];
    const events = await collect(
      p.runTurn(
        turnOpts("please use-tool", {
          canUseTool: async (_toolId, _approvalId, toolName, input) => {
            gated.push({ name: toolName, input });
            return { behavior: "allow" as const };
          },
        }),
      ),
    );
    await p.teardown();

    expect(gated).toEqual([
      { name: "Bash", input: { command: "rm -rf /tmp/scratch", cwd: "/tmp", reason: "cleanup" } },
    ]);
    // tool_start announced at approval time, tool_complete after codex ran it.
    const start = events.find((e) => e.type === "tool_start");
    expect(start && (start as { name: string }).name).toBe("Bash");
    const complete = events.find((e) => e.type === "tool_complete");
    expect(complete && (complete as { output: string }).output).toBe("removed");
    expect(events.some((e) => e.type === "text_done" && e.content === "Cleaned up.")).toBe(true);
  });

  it("C3: denial reaches codex and the item never runs", async () => {
    const p = makeProvider();
    const events = await collect(
      p.runTurn(
        turnOpts("please use-tool", {
          canUseTool: async () => ({ behavior: "deny" as const, message: "no" }),
        }),
      ),
    );
    await p.teardown();

    expect(events.some((e) => e.type === "tool_complete")).toBe(false);
    expect(events.some((e) => e.type === "text_done" && e.content === "Approval denied; skipping.")).toBe(true);
  });

  it("C4: non-gated item is recorded retrospectively as start+complete", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("auto-tool please")));
    await p.teardown();

    const start = events.find((e) => e.type === "tool_start");
    const complete = events.find((e) => e.type === "tool_complete");
    expect(start).toBeDefined();
    expect(complete).toBeDefined();
    if (start?.type === "tool_start") {
      expect(start.name).toBe("Bash");
      expect(start.input).toEqual({ command: "ls -la" });
    }
    if (complete?.type === "tool_complete") {
      expect(complete.output).toBe("file-a\nfile-b");
      expect(complete.success).toBe(true);
    }
  });

  it("C5: seedFromHistory prepends the structured transcript to the first prompt", async () => {
    const p = makeProvider();
    p.seedFromHistory([
      { role: "user", content: "earlier question" },
      {
        role: "assistant",
        content: "earlier answer",
        providerId: "claude",
        model: "opus",
        toolCalls: [
          { id: "t1", name: "run_shell", input: { command: "bun test" }, output: "1 pass", success: true },
        ],
      },
    ]);
    const events = await collect(p.runTurn(turnOpts("echo-prompt")));
    await p.teardown();

    const done = events.find((e) => e.type === "text_done");
    expect(done).toBeDefined();
    if (done?.type === "text_done") {
      expect(done.content).toContain("<conversation-history>");
      expect(done.content).toContain("### Tool call: run_shell → ok");
      expect(done.content).toContain("echo-prompt");
    }

    // One-shot: the second turn goes through clean.
    const second = await collect(p.runTurn(turnOpts("echo-prompt again")));
    const done2 = second.find((e) => e.type === "text_done");
    if (done2?.type === "text_done") {
      expect(done2.content).not.toContain("<conversation-history>");
    }
    await p.teardown();
  });

  it("C6: requestUserInput select question round-trips the picked option", async () => {
    const p = makeProvider();
    const asked: string[] = [];
    const events = await collect(
      p.runTurn(
        turnOpts("ask-user", {
          requestUserInput: async (req) => {
            asked.push(`${req.method}:${req.title}:${(req.options ?? []).join("|")}`);
            return { value: "prod", cancelled: false };
          },
        }),
      ),
    );
    await p.teardown();

    expect(asked).toEqual(["select:Pick one:dev|prod"]);
    expect(events.some((e) => e.type === "text_done" && e.content === "You picked: prod")).toBe(true);
  });

  it("C7: a missing codex binary surfaces a clear error", async () => {
    const p = makeProvider("/nonexistent/codex-binary", []);
    const events = await collect(p.runTurn(turnOpts("hello")));
    await p.teardown();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("C8: model/list maps to ModelInfo", async () => {
    const p = makeProvider();
    // Warm the process + thread with a cheap turn first.
    await collect(p.runTurn(turnOpts("hello")));
    const models = await p.listModels();
    await p.teardown();
    expect(models).toEqual([
      { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced agentic coding model." },
    ]);
  });

  it("C9: lifecycle — thread id becomes the backing id, reset/setHasQueried/dispose, onModels fires", async () => {
    const reported: Array<{ value: string; displayName: string }> = [];
    const p = new CodexProvider({
      sessionId: "sess-1",
      initialBackingId: "sess-1",
      command: process.execPath,
      argsPrefix: [FIXTURE],
      store: {} as Store,
      onModels: (models) => reported.push(...models.map((m) => ({ value: m.value, displayName: m.displayName }))),
    });
    expect(p.hasQueried).toBe(false);
    expect(p.queuedMessages).toBe(0);

    await collect(p.runTurn(turnOpts("hello")));
    expect(p.hasQueried).toBe(true);
    // codex minted the thread — it round-trips as the backing session id.
    expect(p.backingSessionId).toBe("codex-thread-1");
    expect(reported).toEqual([{ value: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" }]);

    p.setHasQueried(false);
    expect(p.hasQueried).toBe(false);
    p.resetToNewSession("fresh-backing");
    expect(p.backingSessionId).toBe("fresh-backing");

    await p.dispose(); // teardown via dispose
    expect(await p.listModels()).toEqual([]); // no live process → empty catalog
  });

  it("C10: interrupt() sends turn/interrupt and the turn ends as interrupted", async () => {
    const p = makeProvider();
    const run = p.runTurn(turnOpts("hang-forever"));
    // Give the turn time to start (thread + turn/start round trips).
    await new Promise((r) => setTimeout(r, 300));
    await run.interrupt();
    const events = await collect(run);
    await p.teardown();

    const done = events.find((e) => e.type === "turn_done");
    expect(done).toBeDefined();
    if (done?.type === "turn_done") expect(done.result.stopReason).toBe("interrupted");
  });

  it("C11: unknown server→client requests are refused with a JSON-RPC error (fail closed)", async () => {
    const p = makeProvider();
    const events = await collect(p.runTurn(turnOpts("unknown-request")));
    await p.teardown();
    // The fixture saw an error response — codeoid refused rather than guessed.
    expect(events.some((e) => e.type === "text_done" && e.content === "server-request-errored")).toBe(true);
  });

  it("C12: rpc edges — spawn failure, request timeout, request/notify after exit", async () => {
    // Spawn failure rejects in-flight requests.
    const dead = new CodexRpcProcess({
      command: "/nonexistent/codex-binary",
      cwd: "/tmp",
      env: {},
      onNotification: () => {},
      onServerRequest: async () => ({}),
      onExit: () => {},
    });
    expect(dead.request("initialize", {})).rejects.toThrow(/spawn failed|exited/);

    // A request the server never answers times out.
    const exited = new Promise<void>((resolve) => {
      const rpc = new CodexRpcProcess({
        command: process.execPath,
        argsPrefix: [FIXTURE],
        cwd: "/tmp",
        env: { PATH: process.env.PATH ?? "" },
        onNotification: () => {},
        onServerRequest: async () => ({}),
        onExit: () => resolve(),
      });
      void (async () => {
        expect(rpc.request("test/noReply", {}, 200)).rejects.toThrow(/timed out/);
        await new Promise((r) => setTimeout(r, 250));
        rpc.kill();
        await exitedSoon(rpc);
        // Post-exit: requests reject, notify is a silent no-op.
        expect(rpc.request("initialize", {})).rejects.toThrow(/exited/);
        rpc.notify("initialized");
      })();
    });
    await exited;
  });
});

/** Wait until the rpc process reports dead. */
async function exitedSoon(rpc: CodexRpcProcess): Promise<void> {
  const deadline = Date.now() + 2000;
  while (rpc.alive) {
    if (Date.now() > deadline) throw new Error("codex rpc never exited");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("codex resolution + registry", () => {
  it("config override → PATH → null, with registry hints", () => {
    // Bogus configured command → supported-but-unavailable with the hint.
    const config = {
      providers: {
        pi: { enabled: false, command: "pi" },
        codex: { enabled: true, command: "/definitely/missing/codex" },
      },
    } as unknown as CodeoidConfig;
    const registry = createDefaultProviderRegistry(config);
    expect(registry.has("codex")).toBe(false);
    expect(registry.unavailableHint("codex")).toContain("providers.codex.command");

    // Bare-name override resolves via PATH; system codex resolves as "path".
    const tmp = mkdtempSync(join(tmpdir(), "codeoid-codex-resolve-"));
    // Isolated env: empty HOME + no version-manager vars, so the node-bin
    // fallback has nothing to find (the real machine's nvm codex can't leak in).
    const isolated = { PATH: "", HOME: join(tmp, "empty-home") };

    // No codex anywhere → null + generic install hint.
    expect(resolveCodexCommand(undefined, isolated)).toBeNull();

    try {
      const bin = join(tmp, "my-codex");
      writeFileSync(bin, "#!/bin/sh\necho fake-codex\n");
      chmodSync(bin, 0o755);
      expect(resolveCodexCommand("my-codex", { PATH: tmp })).toEqual({
        command: bin,
        argsPrefix: [],
        source: "config",
      });
      expect(resolveCodexCommand("missing-name", { PATH: tmp })).toBeNull();
      const sys = join(tmp, "codex");
      writeFileSync(sys, "#!/bin/sh\necho fake-codex\n");
      chmodSync(sys, 0o755);
      expect(resolveCodexCommand(undefined, { PATH: tmp })).toEqual({
        command: sys,
        argsPrefix: [],
        source: "path",
      });

      // node-bin fallback: codex NOT on PATH but in ~/.npm-global/bin — the
      // "daemon PATH omits the user's node bin" case this fix exists for.
      const nodeBin = join(tmp, "home", ".npm-global", "bin");
      mkdirSync(nodeBin, { recursive: true });
      const codexInNodeBin = join(nodeBin, "codex");
      writeFileSync(codexInNodeBin, "#!/bin/sh\necho fake\n");
      chmodSync(codexInNodeBin, 0o755);
      expect(resolveCodexCommand(undefined, { PATH: "", HOME: join(tmp, "home") })).toEqual({
        command: codexInNodeBin,
        argsPrefix: [],
        source: "node-bin",
      });

      // nvm: codex under ~/.nvm/versions/node/<version>/bin, resolved
      // NEWEST-version-first (v21.5.0 preferred over v9.0.0 lexical order).
      const nvmHome = join(tmp, "nvmhome");
      for (const v of ["v9.0.0", "v21.5.0"]) {
        const vbin = join(nvmHome, ".nvm", "versions", "node", v, "bin");
        mkdirSync(vbin, { recursive: true });
        writeFileSync(join(vbin, "codex"), "#!/bin/sh\necho fake\n");
        chmodSync(join(vbin, "codex"), 0o755);
      }
      const nvmResolved = resolveCodexCommand(undefined, { PATH: "", HOME: nvmHome });
      expect(nvmResolved?.source).toBe("node-bin");
      // Highest version wins the sort, even though "v21" < "v9" lexically.
      expect(nvmResolved?.command).toBe(join(nvmHome, ".nvm", "versions", "node", "v21.5.0", "bin", "codex"));

      // Active version-manager env vars are searched too (NVM_BIN /
      // VOLTA_HOME / npm_config_prefix), before the home defaults.
      for (const key of ["NVM_BIN", "VOLTA_HOME", "npm_config_prefix"] as const) {
        const base = join(tmp, key.toLowerCase());
        const bin = key === "NVM_BIN" ? base : join(base, "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "codex"), "#!/bin/sh\necho fake\n");
        chmodSync(join(bin, "codex"), 0o755);
        const r = resolveCodexCommand(undefined, {
          PATH: "",
          HOME: join(tmp, "no-home"),
          [key]: base,
        });
        expect(r?.source).toBe("node-bin");
        expect(r?.command).toBe(join(bin, "codex"));
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // Disabled → absent entirely, no hint.
    const disabled = createDefaultProviderRegistry({
      providers: {
        pi: { enabled: false, command: "pi" },
        codex: { enabled: false, command: "codex" },
      },
    } as unknown as CodeoidConfig);
    expect(disabled.has("codex")).toBe(false);
    expect(disabled.unavailableHint("codex")).toBeUndefined();
  });

  it("compareNodeVersionsDesc orders newest-first and ties equal versions", () => {
    expect(["v9.0.0", "v21.5.0", "v20.11.1"].sort(compareNodeVersionsDesc)).toEqual([
      "v21.5.0",
      "v20.11.1",
      "v9.0.0",
    ]);
    // Equal versions (incl. a missing patch component) compare as 0.
    expect(compareNodeVersionsDesc("v18.0.0", "v18.0")).toBe(0);
    expect(compareNodeVersionsDesc("v18.1.0", "v18.1.0")).toBe(0);
  });
});
