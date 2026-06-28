/**
 * MockSessionProvider — deterministic SessionProvider for integration tests.
 *
 * Extends the scripted-turn model from MockProvider with the seven
 * ClaudeProvider-specific APIs that Session calls beyond AgentProvider:
 *   onRecoveryNeeded, backingSessionId, hasQueried, queuedMessages,
 *   resetToNewSession(), setHasQueried(), teardown()
 *
 * Critically, this mock calls opts.canUseTool for each tool_start event it
 * emits, simulating the SDK's PreToolUse hook.  This is necessary for:
 *   - The autonomous budget to decrement (via #shouldAutoApprove in canUseTool)
 *   - Manual approval flows to work (via #waitForApproval in canUseTool)
 *   - Map cleanup tests to exercise the real denial/interrupt paths
 *
 * Usage:
 *   const provider = new MockSessionProvider("mock", [
 *     [
 *       { type: "text_done",  content: "Hello" },
 *       { type: "turn_done",  result: mockResult() },
 *     ],
 *   ]);
 *   const session = new Session({ ..., _testProvider: provider });
 */

import { AsyncQueue } from "../../async-queue.js";
import type {
  ModelInfo,
  NormalizedTurnResult,
  ProviderEvent,
  SessionProvider,
  TurnOpts,
  TurnRun,
} from "../interface.js";

export { mockResult } from "./index.js";

export class MockSessionProvider implements SessionProvider {
  readonly id: string;
  readonly displayName: string;

  /** Set by Session.send() before each runTurn() call. */
  onRecoveryNeeded: ((content: string) => void) | undefined;

  #backingSessionId: string;
  #hasQueried = false;
  #script: ProviderEvent[][];

  /** Every TurnOpts passed to runTurn() — inspect in tests. */
  readonly capturedOpts: TurnOpts[] = [];

  /** Incremented each time teardown() is called — useful for asserting cleanup. */
  teardownCount = 0;

  constructor(id = "mock-session", script: ProviderEvent[][] = []) {
    this.id = id;
    this.displayName = `MockSession(${id})`;
    this.#backingSessionId = `${id}-backing`;
    this.#script = script.map((s) => [...s]);
  }

  get backingSessionId(): string { return this.#backingSessionId; }
  get hasQueried(): boolean { return this.#hasQueried; }
  get queuedMessages(): number { return 0; }

  resetToNewSession(newBackingId: string): void {
    this.#backingSessionId = newBackingId;
    this.#hasQueried = false;
  }

  setHasQueried(value: boolean): void {
    this.#hasQueried = value;
  }

  async teardown(): Promise<void> {
    this.teardownCount++;
    this.onRecoveryNeeded = undefined;
  }

  async dispose(): Promise<void> {
    return this.teardown();
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "mock-model", displayName: "Mock Model" }];
  }

  runTurn(opts: TurnOpts): TurnRun {
    this.capturedOpts.push(opts);
    this.#hasQueried = true;

    const events = this.#script.shift() ?? [
      { type: "turn_done", result: defaultResult(this.id) } satisfies ProviderEvent,
    ];

    const queue = new AsyncQueue<ProviderEvent>();

    // Emit events asynchronously, calling canUseTool for each tool_start
    // to simulate the SDK's PreToolUse hook firing before the tool runs.
    void this.#emit(events, queue, opts);

    return {
      events: queue,
      interrupt: async () => {
        queue.close(); // idempotent — safe to call even if already closed
      },
    };
  }

  async #emit(events: ProviderEvent[], queue: AsyncQueue<ProviderEvent>, opts: TurnOpts): Promise<void> {
    // Yield once so Session's #consumeEvents loop has started its for-await
    // before we begin pushing — avoids losing the first item if the consumer
    // hasn't reached its first `next()` call yet.
    await Promise.resolve();

    for (const event of events) {
      try {
        queue.push(event);
      } catch {
        break; // queue was closed by interrupt()
      }

      if (event.type === "tool_start") {
        // Use setTimeout(0) to flush ALL pending microtasks — this ensures
        // Session's #handleProviderEvent fully processes tool_start (registering
        // the approvalId in #approvalIdToMessageId) before we call canUseTool.
        // canUseTool's #shouldAutoApprove runs synchronously (before its own
        // `await Promise.resolve()`), then canUseTool cleans up #approvalIdToMessageId.
        // Without this flush the cleanup arrives before the registration.
        await new Promise<void>((r) => setTimeout(r, 0));
        try {
          await opts.canUseTool(event.toolId, event.approvalId, event.name, event.input);
        } catch {
          // canUseTool rejection (very unusual — normally returns {behavior}) — treat as denial.
        }
      }
    }

    queue.close();
  }
}

function defaultResult(providerId: string): NormalizedTurnResult {
  return {
    providerId,
    model: "mock-model",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    durationMs: 1,
  };
}
