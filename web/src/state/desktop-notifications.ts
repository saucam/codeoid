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
import { epochOf, messagesFor } from "./messages";
import { sessionList } from "./sessions";

export type NotifyState = "default" | "granted" | "denied" | "unsupported";

const [permission, setPermission] = createSignal<NotifyState>(detect());
// Reactive mirror of document.hidden — so the watcher re-fires when the tab is
// backgrounded (document.hidden isn't a signal; reading it wouldn't subscribe).
const [docHidden, setDocHidden] = createSignal(
  typeof document !== "undefined" ? document.hidden : true,
);
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
    if (typeof document !== "undefined") setDocHidden(document.hidden);
  }
  onMount(() => {
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    onCleanup(() => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    });
  });

  // Watch EVERY session, not just the focused one — an approval on a
  // BACKGROUND session, while the user is away, is exactly when a desktop
  // notification matters most. Stays cheap: the per-session status gate skips
  // the message scan (and the epoch subscription) for anything not already in
  // `waiting_approval`, so a streaming session's deltas don't re-run this.
  createEffect(() => {
    // Read every reactive dependency up front. A bare early return would leave
    // this effect depending only on permission(), so becoming-hidden (which
    // re-sets the same granted permission) wouldn't retrigger the scan and a
    // background approval would be missed.
    const granted = permission() === "granted";
    const hidden = docHidden();
    const sessions = sessionList();
    // Only fire while the user isn't actively looking at the page.
    if (!granted || !hidden) return;
    for (const session of sessions) {
      if (session.status !== "waiting_approval") continue;
      epochOf(session.id); // track in-place tool-state mutations for THIS session
      const match = findPendingApproval(messagesFor(session.id), session.status);
      if (!match || !match.tool || match.tool.state.phase !== "waiting_confirmation") continue;
      const approvalId = match.tool.state.approvalId;
      if (fired.has(approvalId)) continue;
      // Bound the dedupe set — one entry per approvalId, forever, otherwise
      // grows without limit over a long-lived tab. Drop the oldest half at the
      // cap; resolved approvals never re-notify, so evicting old ids is harmless.
      if (fired.size >= FIRED_CAP) {
        let drop = fired.size - FIRED_CAP / 2;
        for (const id of fired) {
          if (drop-- <= 0) break;
          fired.delete(id);
        }
      }
      fired.add(approvalId);
      fireApprovalNotification(
        session.name,
        match.tool.name,
        match.tool.state.description ?? match.tool.name,
        approvalId,
      );
    }
  });
}

function fireApprovalNotification(
  sessionName: string,
  toolName: string,
  description: string,
  approvalId: string,
): void {
  try {
    const n = new Notification(`codeoid · ${toolName} needs approval`, {
      body: `${sessionName}: ${description}`,
      tag: `codeoid-approval-${approvalId}`,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (err) {
    console.warn("[codeoid] notification failed:", err);
  }
}
