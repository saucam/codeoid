/**
 * Live model catalog from the daemon (which sources it from the Claude Code
 * backend via the SDK's `supportedModels()`), so `/model` and the picker use
 * the real, current models instead of a list baked into the client that goes
 * stale. Fetched once after connect; `live` is false when the daemon is still
 * serving its built-in fallback (no session has initialized yet).
 */

import { createSignal } from "solid-js";

import { getClient, newRequestId } from "./connection";
import type { ModelInfo, ModelsListResultMsg } from "../protocol/types";

const [models, setModels] = createSignal<ModelInfo[]>([]);
const [live, setLive] = createSignal(false);

/** Current model catalog (may be the daemon's fallback until `modelsLive()`). */
export const modelCatalog = models;
/** True once the catalog reflects the live backend list, not a fallback. */
export const modelsLive = live;

let fetched = false;

/** Fetch the model catalog from the daemon. Safe to call repeatedly. */
export async function fetchModels(force = false): Promise<void> {
  if (fetched && !force && live()) return;
  try {
    const id = newRequestId();
    const result = await getClient().request<ModelsListResultMsg>(
      { type: "models.list", id },
      {
        waitForResult: (m) =>
          m.type === "models.list.result" && m.requestId === id ? m : undefined,
        timeoutMs: 8_000,
      },
    );
    fetched = true;
    setModels(result.models);
    setLive(result.live);
  } catch {
    // Non-fatal — the prompt/picker fall back to whatever is cached (possibly
    // empty), and the daemon still validates /model server-side.
  }
}

/**
 * Resolve user input → a canonical model value against the fetched catalog,
 * mirroring the daemon: exact value, case-insensitive display name, or a
 * claude-* passthrough. Returns null when nothing matches (caller reports the
 * available values). When the catalog is empty (not yet fetched), returns the
 * trimmed input so we don't block before the list arrives — the daemon is the
 * backstop validator.
 */
export function resolveModelInput(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  const list = models();
  if (list.length === 0) return t;
  const lower = t.toLowerCase();
  for (const m of list) {
    if (m.value.toLowerCase() === lower) return m.value;
    if (m.displayName.toLowerCase() === lower) return m.value;
  }
  if (/^claude-/i.test(t)) return t;
  return null;
}

export function _resetModelsForTest(): void {
  fetched = false;
  setModels([]);
  setLive(false);
}
