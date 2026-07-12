/**
 * REAL pi integration tests — opt-in. The counterpart to
 * provider-codex.integration.test.ts, for the pi harness.
 *
 * The offline suite (provider-pi.test.ts) runs against fake-pi. These drive
 * codeoid's real PiProvider against the actual pi binary (bundled
 * @earendil-works/pi-coding-agent, a system pi, or providers.pi.command) so
 * the full spawn → JSONL framing → bridge approvals → turn-accounting pipeline
 * is exercised against the real thing.
 *
 * Gated: skipped unless CODEOID_PI_INTEGRATION=1 AND pi resolves on this host.
 * pi ALSO needs a provider configured/authenticated (an API key in the env, or
 * `pi` logged in) — without it a turn fails on "No API key found". Example:
 *
 *   CODEOID_PI_INTEGRATION=1 GOOGLE_API_KEY=... \
 *     bun test src/tests/provider-pi.integration.test.ts
 *
 *   P1  a fresh text turn runs to turn_done with a reply, no error
 *   P2  pi runs a shell tool end-to-end and its output reaches codeoid
 *
 * See also backends.integration.test.ts, which exercises pi (when enabled) in
 * the cross-backend FRESH + RESUME matrix through the real SessionManager.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiProvider } from "../daemon/providers/pi/index.js";
import { resolvePiCommand } from "../daemon/providers/pi/resolve.js";
import { Store } from "../daemon/store.js";
import type { ProviderEvent, TurnOpts, TurnRun } from "../daemon/providers/interface.js";

const resolved = resolvePiCommand(undefined);
const RUN = process.env.CODEOID_PI_INTEGRATION === "1" && resolved !== null;
const maybe = RUN ? it : it.skip;

if (!RUN) {
  // eslint-disable-next-line no-console
  console.log(
    `[pi integration] SKIPPED — set CODEOID_PI_INTEGRATION=1 and install+auth pi to run (resolved=${resolved ? resolved.command : "none"}).`,
  );
}

const WORK = RUN ? mkdtempSync(join(tmpdir(), "codeoid-pi-it-")) : "/tmp";
let store: Store | null = null;
afterAll(() => {
  if (!RUN) return;
  store?.close();
  rmSync(WORK, { recursive: true, force: true });
});

function makeProvider(): PiProvider {
  store ??= new Store(join(WORK, "pi.db"));
  return new PiProvider({
    sessionId: "pi-it",
    initialBackingId: "pi-it",
    command: resolved!.command,
    argsPrefix: resolved!.argsPrefix,
    store,
  });
}

function turnOpts(userMessage: string, overrides: Partial<TurnOpts> = {}): TurnOpts {
  return {
    history: [],
    userMessage,
    workdir: WORK,
    // Autonomous-equivalent: auto-approve everything the bridge asks about.
    canUseTool: async () => ({ behavior: "allow" as const }),
    ...overrides,
  };
}

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

describe("PiProvider — REAL pi integration", () => {
  maybe(
    "P1: a fresh text turn runs to completion with a reply and no error",
    async () => {
      const p = makeProvider();
      try {
        const events = await collect(p.runTurn(turnOpts("Reply with exactly the word: ok")), 90_000);
        expect(errorText(events)).toBe("");
        expect(events.some((e) => e.type === "turn_done")).toBe(true);
        const text = events
          .filter((e) => e.type === "text_done" || e.type === "text_delta")
          .map((e) => (e as { content: string }).content)
          .join("");
        expect(text.trim().length).toBeGreaterThan(0);
      } finally {
        await p.teardown();
      }
    },
    120_000,
  );

  maybe(
    "P2: pi runs a shell tool end-to-end and its output reaches codeoid",
    async () => {
      const p = makeProvider();
      try {
        const events = await collect(
          p.runTurn(
            turnOpts(
              "Run this shell command and reply with ONLY the number it prints: printf 'a\\nb\\n' | wc -l",
            ),
          ),
          120_000,
        );
        expect(errorText(events)).toBe("");
        expect(events.some((e) => e.type === "tool_complete")).toBe(true);
        expect(events.some((e) => e.type === "turn_done")).toBe(true);
      } finally {
        await p.teardown();
      }
    },
    150_000,
  );
});
