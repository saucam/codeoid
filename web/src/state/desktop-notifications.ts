/**
 * Desktop-notification bridge for tool approvals.
 *
 * Watches the focused session's messages for any tool_call entering
 * `waiting_confirmation` while the document is hidden. When that
 * happens, fires a single Notification per approvalId so the user
 * knows the agent is blocked even if the tab is in another desktop or
 * a background pinned tab. Clicking the notification focuses this
 * window. Doesn't fire when the tab is already visible — the
 * ApprovalBar's accent strip is enough then.
 *
 * Permission lifecycle:
 *   - `enabled()` reflects what the browser told us this session
 *     (`Notification.permission`).
 *   - The user opts in once via `requestEnable()`. If denied, the
 *     watcher never fires; we don't pester them again unless they
 *     explicitly try to enable from settings.
 *
 * Single-fire de-dup: an approvalId only triggers one notification per
 * session lifetime, no matter how many delta-driven updates land on
 * that message. We track fired IDs in an in-memory Set; that's fine
 * because notifications are only useful in the present moment.
 */

import { createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { findPendingApproval } from "../lib/approvals";
import { epochOf, focusedSessionMessages } from "./messages";
import { focusedSession, focusedSessionId } from "./sessions";

export type NotifyState = "default" | "granted" | "denied" | "unsupported";

const [permission, setPermission] = createSignal<NotifyState>(detect());
const fired = new Set<string>();
const FIRED_CAP = 1000;

function detect(): NotifyState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyState;
}

export function notifyPermission(): NotifyState {
  return permission();
}

/**
 * Ask the user once for desktop-notification permission. Resolves to
 * the new permission state. Does nothing when already granted/denied;
 * the browser refuses re-prompts after the user has decided.
 */
export async function requestEnable(): Promise<NotifyState> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    setPermission(result as NotifyState);
    return result as NotifyState;
  }
  setPermission(Notification.permission as NotifyState);
  return Notification.permission as NotifyState;
}

/**
 * Mount once per app instance. Watches the focused session and fires a
 * desktop notification when an approval enters waiting_confirmation
 * AND the document is hidden AND we have permission. Cleans itself up.
 */
export function installApprovalNotifications(): void {
  if (typeof window === "undefined") return;

  // Re-detect permission on focus — the user might have flipped it via
  // browser settings between sessions.
  function refresh(): void {
    setPermission(detect());
  }
  onMount(() => {
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    onCleanup(() => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    });
  });

  // Use the shared focused-messages memo. Reading both the messages
  // accessor AND the per-session epoch inside the effect makes Solid
  // re-fire on mutations even when the array reference is stable
  // (deltas mutate in place).
  createEffect(() => {
    permission(); // track
    const sid = focusedSessionId();
    epochOf(sid); // track in-place mutations
    if (!sid) return;
    const session = focusedSession();
    if (!session) return;
    // Status-gated, turn-bounded scan — see lib/approvals.ts. Previously
    // this walked the ENTIRE array from index 0 on every streaming delta.
    const match = findPendingApproval(focusedSessionMessages(), session.status);
    if (!match || !match.tool || match.tool.state.phase !== "waiting_confirmation") return;
    const pending = {
      approvalId: match.tool.state.approvalId,
      toolName: match.tool.name,
      description: match.tool.state.description ?? match.tool.name,
    };
    if (fired.has(pending.approvalId)) return;
    if (permission() !== "granted") return;
    // Only fire when the user isn't actively looking at the page.
    // `document.hidden` covers both backgrounded tabs and minimised
    // windows on most browsers.
    if (typeof document !== "undefined" && !document.hidden) return;
    // Bound the dedupe set — one entry per approvalId, forever, otherwise grows
    // without limit over a long-lived tab. Drop the oldest half at the cap;
    // resolved approvals never re-notify, so evicting old ids is harmless.
    if (fired.size >= FIRED_CAP) {
      let drop = fired.size - FIRED_CAP / 2;
      for (const id of fired) {
        if (drop-- <= 0) break;
        fired.delete(id);
      }
    }
    fired.add(pending.approvalId);
    try {
      const n = new Notification(
        `codeoid · ${pending.toolName} needs approval`,
        {
          body: `${session.name}: ${pending.description}`,
          tag: `codeoid-approval-${pending.approvalId}`,
          requireInteraction: true,
        },
      );
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch (err) {
      console.warn("[codeoid] notification failed:", err);
    }
  });
}
