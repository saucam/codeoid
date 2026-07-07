/**
 * Per-session prompt drafts. Stored in localStorage so a reload doesn't
 * lose the half-typed message. Keyed by sessionId — switching sessions
 * mid-edit just snapshots the current text into its session and pulls
 * up whatever was saved for the destination.
 *
 * This is the *only* form of client-side persistence allowed (the others
 * are forbidden — see project_codeoid_clients_are_renderers memory).
 * Drafts are pure UX, never authoritative.
 */

import { batch, createSignal } from "solid-js";

const STORAGE_KEY = "codeoid.draftsByID";

const [drafts, setDrafts] = createSignal<Record<string, string>>(loadDrafts());

export function getDraft(sessionId: string): string {
  return drafts()[sessionId] ?? "";
}

export function setDraft(sessionId: string, text: string): void {
  batch(() => {
    setDrafts((cur) => {
      const next = { ...cur, [sessionId]: text };
      persist(next);
      return next;
    });
  });
}

export function clearDraft(sessionId: string): void {
  batch(() => {
    setDrafts((cur) => {
      if (!(sessionId in cur)) return cur;
      const next = { ...cur };
      delete next[sessionId];
      persist(next);
      return next;
    });
  });
}

// ---------- internals ----------

function loadDrafts(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupt — start fresh.
  }
  return {};
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: Record<string, string> | null = null;

/** Debounced write. `setDraft` fires on every keystroke and previously did a
 * `JSON.stringify` of the whole map + a synchronous `localStorage.setItem` each
 * time, blocking the main thread per keypress. Coalesce to a trailing write;
 * flush on pagehide so a draft typed right before the tab closes isn't lost. */
function persist(next: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  pendingPersist = next;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(flushPersist, 400);
}

function flushPersist(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const toWrite = pendingPersist;
  pendingPersist = null;
  if (!toWrite || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toWrite));
  } catch {
    // Quota exceeded or storage unavailable — drafts become memory-only.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
}

export function _resetDraftsForTest(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersist = null;
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  setDrafts({});
}
