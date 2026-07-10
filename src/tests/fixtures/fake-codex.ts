/**
 * fake-codex — offline stand-in for `codex app-server` (newline JSON-RPC).
 *
 * Mirrors the wire behavior probed against @openai/codex@0.144.1
 * (docs/provider-codex-design.md → Probe results). Turn behavior is keyed
 * off the prompt text, like fake-pi:
 *
 *   "use-tool"   → server→client item/commandExecution/requestApproval,
 *                  then runs or skips the item based on the decision
 *   "auto-tool"  → item/completed for a command codex ran WITHOUT asking
 *   "ask-user"   → server→client item/tool/requestUserInput (select)
 *   "echo-prompt"→ agentMessage containing the full received prompt
 *   default      → two agentMessage deltas + completed message
 *
 * Every turn ends with turn/completed carrying usage.
 */

const enc = new TextEncoder();
function send(obj: unknown): void {
  process.stdout.write(enc.encode(`${JSON.stringify(obj)}\n`));
}

let nextServerReqId = 1000;
const pendingServerReqs = new Map<number, (result: Record<string, unknown>) => void>();

function serverRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextServerReqId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pendingServerReqs.set(id, resolve));
}

function usage() {
  return { inputTokens: 120, cachedInputTokens: 20, outputTokens: 45 };
}

async function runTurn(threadId: string, prompt: string): Promise<void> {
  send({ method: "turn/started", params: { turn: { id: "turn-1" } } });

  if (prompt.includes("use-tool")) {
    const decision = await serverRequest("item/commandExecution/requestApproval", {
      threadId,
      turnId: "turn-1",
      itemId: "item-cmd-1",
      command: "rm -rf /tmp/scratch",
      cwd: "/tmp",
      reason: "cleanup",
    });
    if (decision.decision === "approved") {
      send({
        method: "item/completed",
        params: {
          item: { id: "item-cmd-1", type: "commandExecution", command: "rm -rf /tmp/scratch", aggregatedOutput: "removed", status: "completed" },
        },
      });
      send({ method: "item/agentMessage/delta", params: { delta: "Cleaned up." } });
      send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Cleaned up." } } });
    } else {
      send({ method: "item/agentMessage/delta", params: { delta: "Approval denied; skipping." } });
      send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Approval denied; skipping." } } });
    }
  } else if (prompt.includes("auto-tool")) {
    // codex ran a trusted read without asking — only item/completed arrives.
    send({
      method: "item/completed",
      params: { item: { id: "item-auto-1", type: "commandExecution", command: "ls -la", aggregatedOutput: "file-a\nfile-b", status: "completed" } },
    });
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Listed files." } } });
  } else if (prompt.includes("ask-user")) {
    const answer = await serverRequest("item/tool/requestUserInput", {
      threadId,
      turnId: "turn-1",
      itemId: "item-q-1",
      questions: [
        { id: "q1", header: "Pick one", question: "Which env?", options: [{ label: "dev" }, { label: "prod" }] },
      ],
    });
    const answers = answer.answers as Array<{ answer?: string | null }> | undefined;
    const picked = answers?.[0]?.answer ?? "no-answer";
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: `You picked: ${picked}` } } });
  } else if (prompt.includes("hang-forever")) {
    // Emit nothing further — the test interrupts the turn.
    return;
  } else if (prompt.includes("unknown-request")) {
    const resp = await serverRequest("custom/unknownThing", { anything: true });
    const text = resp.__error ? "server-request-errored" : "server-request-oddly-ok";
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text } } });
  } else if (prompt.includes("echo-prompt")) {
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: `PROMPT:${prompt}` } } });
  } else {
    send({ method: "item/reasoning/textDelta", params: { delta: "thinking..." } });
    send({ method: "item/agentMessage/delta", params: { delta: "Hello " } });
    send({ method: "item/agentMessage/delta", params: { delta: "world" } });
    send({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "Hello world" } } });
  }

  send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", usage: usage() } } });
}

let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  for (;;) {
    const idx = buf.indexOf("\n");
    if (idx < 0) break;
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(frame);
  }
});

async function handle(frame: Record<string, unknown>): Promise<void> {
  const id = frame.id as number | undefined;
  const method = frame.method as string | undefined;
  const params = (frame.params ?? {}) as Record<string, unknown>;

  // Response to one of OUR server→client requests.
  if (id !== undefined && method === undefined) {
    const resolve = pendingServerReqs.get(id);
    if (resolve) {
      pendingServerReqs.delete(id);
      const error = frame.error as { message?: string } | undefined;
      resolve(
        error
          ? { __error: error.message ?? "error" }
          : ((frame.result ?? { decision: "denied" }) as Record<string, unknown>),
      );
    }
    return;
  }
  if (method === undefined) return;

  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "fake-codex/0.144.1" } });
      break;
    case "initialized":
      break;
    case "thread/start":
      send({ id, result: { thread: { id: "codex-thread-1" } } });
      send({ method: "thread/started", params: { thread: { id: "codex-thread-1" } } });
      break;
    case "thread/resume":
      send({ id, result: { thread: { id: String(params.threadId ?? "codex-thread-1") } } });
      break;
    case "model/list":
      send({
        id,
        result: {
          data: [
            { id: "gpt-5.6-terra", model: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced agentic coding model." },
          ],
        },
      });
      break;
    case "turn/start": {
      send({ id, result: { turn: { id: "turn-1" } } });
      const input = params.input as Array<{ type: string; text?: string }> | undefined;
      const prompt = input?.find((i) => i.type === "text")?.text ?? "";
      void runTurn(String(params.threadId ?? ""), prompt);
      break;
    }
    case "turn/interrupt":
      send({ id, result: {} });
      send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted", usage: usage() } } });
      break;
    case "test/noReply":
      break; // deliberately never answered — rpc timeout test
    default:
      send({ id, error: { code: -32601, message: `fake-codex: unknown method ${method}` } });
      break;
  }
}

// Module scope (avoids global-script collisions with other fixtures under tsc).
export {};
