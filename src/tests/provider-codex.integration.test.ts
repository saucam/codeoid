/**
 * REAL `codex app-server` integration tests — opt-in.
 *
 * The offline suite (provider-codex.test.ts) runs against fake-codex, which
 * cannot catch wire-shape drift from the real binary — that is exactly how the
 * #163 `sandboxPolicy` bug shipped green (the fake accepted a shape the real
 * codex rejects at turn/start). These tests drive codeoid's REAL CodexProvider
 * against the installed `codex app-server` to ascertain robustness end to end.
 *
 * Gated: skipped unless CODEOID_CODEX_INTEGRATION=1 AND codex resolves on this
 * host. The runner must have codex installed and authenticated (~/.codex).
 *
 *   CODEOID_CODEX_INTEGRATION=1 bun test src/tests/provider-codex.integration.test.ts
 *
 *   I1  a text turn ACCEPTS the tagged sandboxPolicy for ALL 3 sandbox modes
 *       (no "invalid type ... SandboxPolicyDeserialize" deserialize error at
 *       turn/start — the regression this whole change exists to prevent)
 *   I2  the default (danger-full-access) EXECUTES a shell command end-to-end
 *       and the tool output reaches codeoid — the original autonomous-mode
 *       "command execution was rejected" failure, now passing
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "../daemon/providers/codex/index.js";
import { resolveCodexCommand } from "../daemon/providers/codex/resolve.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";
import type { Store } from "../daemon/store.js";

const resolved = resolveCodexCommand(undefined);
const RUN = process.env.CODEOID_CODEX_INTEGRATION === "1" && resolved !== null;
const maybe = RUN ? it : it.skip;

if (!RUN) {
  // Make the skip reason obvious in test output rather than silent.
  // eslint-disable-next-line no-console
  console.log(
    `[codex integration] SKIPPED — set CODEOID_CODEX_INTEGRATION=1 and install/auth codex to run (resolved=${resolved ? resolved.command : "none"}).`,
  );
}

const WORK = RUN ? mkdtempSync(join(tmpdir(), "codeoid-codex-it-")) : "/tmp";
afterAll(() => {
  if (RUN) rmSync(WORK, { recursive: true, force: true });
});

function makeProvider(): CodexProvider {
  return new CodexProvider({
    sessionId: "it-sess",
    initialBackingId: "it-sess",
    command: resolved!.command,
    argsPrefix: resolved!.argsPrefix,
    store: {} as Store,
  });
}

function turnOpts(userMessage: string, overrides: Partial<TurnOpts> = {}): TurnOpts {
  return {
    history: [],
    userMessage,
    workdir: WORK,
    // Autonomous-equivalent: auto-approve everything, like codeoid's gate does
    // in autonomous mode. The point under test is codex EXECUTING what we allow.
    canUseTool: async () => ({ behavior: "allow" as const }),
    ...overrides,
  };
}

/** Drain a run to turn_done/error, with a wall-clock ceiling. */
async function collect(run: TurnRun, ms: number): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const timer = setTimeout(() => void run.interrupt(), ms);
  try {
    for await (const event of run.events) {
      events.push(event);
      if (event.type === "turn_done" || event.type === "error") break;
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

function errorText(events: ProviderEvent[]): string {
  return events
    .filter((e) => e.type === "error")
    .map((e) => (e as { message: string }).message)
    .join(" | ");
}

describe("CodexProvider — REAL codex app-server integration", () => {
  maybe(
    "I1: a text turn is accepted (no SandboxPolicy deserialize error) under all 3 sandbox modes",
    async () => {
      for (const mode of ["danger-full-access", "read-only", "workspace-write"]) {
        const prev = process.env.CODEX_SANDBOX_POLICY;
        process.env.CODEX_SANDBOX_POLICY = mode;
        const p = makeProvider();
        try {
          const events = await collect(p.runTurn(turnOpts("Reply with exactly the word: ok")), 60_000);
          const err = errorText(events);
          // The bug manifested as this exact deserialize error at turn/start.
          expect(err).not.toContain("SandboxPolicyDeserialize");
          expect(err).not.toContain("Invalid request");
          // A turn actually started and produced a normalized result.
          expect(events.some((e) => e.type === "turn_done")).toBe(true);
        } finally {
          await p.teardown();
          if (prev === undefined) delete process.env.CODEX_SANDBOX_POLICY;
          else process.env.CODEX_SANDBOX_POLICY = prev;
        }
      }
    },
    200_000,
  );

  maybe(
    "I2: danger-full-access executes a shell command end-to-end and returns its output",
    async () => {
      const prev = process.env.CODEX_SANDBOX_POLICY;
      delete process.env.CODEX_SANDBOX_POLICY; // exercise the default
      const p = makeProvider();
      try {
        const events = await collect(
          p.runTurn(
            turnOpts(
              "Run this shell command and reply with ONLY the number it prints, nothing else: printf 'a\\nb\\nc\\n' | wc -l",
            ),
          ),
          90_000,
        );
        expect(errorText(events)).toBe("");
        // codex ran a command and its output flowed back as a tool_complete.
        const completes = events.filter((e) => e.type === "tool_complete");
        expect(completes.length).toBeGreaterThan(0);
        expect(events.some((e) => e.type === "turn_done")).toBe(true);
        // The model's final answer should contain the count (3).
        const finalText = events
          .filter((e) => e.type === "text_done")
          .map((e) => (e as { content: string }).content)
          .join("");
        expect(finalText).toContain("3");
      } finally {
        await p.teardown();
        if (prev !== undefined) process.env.CODEX_SANDBOX_POLICY = prev;
      }
    },
    120_000,
  );
});
