/**
 * Provider-command catalogs (`session.commands`).
 *
 * Providers can contribute their own slash commands (pi extension commands,
 * prompt templates, skills). The catalog is fetched lazily per session —
 * `ensureCommands()` on session focus — and consulted by the prompt's slash
 * parser: a verb that isn't a built-in but IS in the catalog passes through
 * as plain prompt text for the provider to expand.
 *
 * Daemons that predate `session.commands` reject the fetch; that session is
 * cached as [] so we don't re-ask on every focus change.
 */

import { createStore, produce, reconcile } from "solid-js/store";

import type { ProviderCommand, SessionCommandsResultMsg } from "../protocol/types";
import { getClient, newRequestId } from "./connection";

interface CommandsState {
  bySession: Record<string, ProviderCommand[]>;
}

const [state, setState] = createStore<CommandsState>({ bySession: {} });
const inflight = new Set<string>();

/** Fetch the provider-command catalog for a session (once; cached). */
export function ensureCommands(sessionId: string): void {
  if (state.bySession[sessionId] !== undefined || inflight.has(sessionId)) return;
  // Not bootstrapped yet (or mocked out in tests) — skip WITHOUT caching so
  // the next focus change retries once the client exists.
  let client: ReturnType<typeof getClient>;
  try {
    client = getClient();
  } catch {
    return;
  }
  inflight.add(sessionId);
  const id = newRequestId();
  client
    .request<SessionCommandsResultMsg>(
      { type: "session.commands", id, sessionId },
      {
        waitForResult: (m) =>
          m.type === "session.commands.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    )
    .then((result) => {
      const commands = Array.isArray(result.commands) ? result.commands : [];
      setState(produce((s) => { s.bySession[sessionId] = commands; }));
    })
    .catch((err: unknown) => {
      // Permanent rejections (daemon predates the verb, scope miss) cache
      // as empty so we don't re-ask on every focus change. Transient
      // failures (timeout, reconnect blip) stay uncached — the next focus
      // retries.
      const message = err instanceof Error ? err.message : String(err);
      const permanent =
        message.includes("Unknown message type") || message.includes("Missing scope");
      if (permanent) {
        setState(produce((s) => { s.bySession[sessionId] = []; }));
      }
    })
    .finally(() => {
      inflight.delete(sessionId);
    });
}

/** The cached catalog for a session ([] until fetched). */
export function providerCommands(sessionId: string | null): ProviderCommand[] {
  if (!sessionId) return [];
  return state.bySession[sessionId] ?? [];
}

/** Case-insensitive membership test for the slash parser's passthrough. */
export function isProviderCommand(sessionId: string | null, name: string): boolean {
  if (!sessionId) return false;
  const lowered = name.toLowerCase();
  return providerCommands(sessionId).some((c) => c.name.toLowerCase() === lowered);
}

/** Drop a session's cached catalog (e.g. after rotate) so it refetches. */
export function invalidateCommands(sessionId: string): void {
  setState(produce((s) => { delete s.bySession[sessionId]; }));
}

/** Test-only reset. */
export function _resetCommandsForTest(): void {
  setState(reconcile({ bySession: {} }));
  inflight.clear();
}
