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
import { join } from "node:path";
import { CodexProvider } from "../daemon/providers/codex/index.js";
import { resolveCodexCommand } from "../daemon/providers/codex/resolve.js";
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
      expect(turnDone.result.inputTokens).toBe(120);
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
});

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

    // No codex anywhere → null + generic install hint.
    expect(resolveCodexCommand(undefined, { PATH: "" })).toBeNull();

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
});
