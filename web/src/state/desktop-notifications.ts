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
import type { SessionInfo, SessionMessage } from "../protocol/types";

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
    // Subscribe to in-place tool-state mutations of the waiting sessions so a
    // second parallel approval (delta, no status change) still retriggers us.
    for (const s of sessions) {
      if (s.status === "waiting_approval") epochOf(s.id);
    }
    for (const p of pendingApprovalsToNotify(sessions, messagesFor)) {
      if (fired.has(p.approvalId)) continue;
      evictToCap(fired, FIRED_CAP);
      fired.add(p.approvalId);
      fireApprovalNotification(p.sessionName, p.toolName, p.description, p.approvalId);
    }
  });
}

export interface ApprovalNotice {
  sessionName: string;
  toolName: string;
  description: string;
  approvalId: string;
}

/** Pure selection: every session in `waiting_approval` with a tool in
 * `waiting_confirmation`, across ALL sessions. Status-gated so it never scans a
 * non-waiting session's messages. */
export function pendingApprovalsToNotify(
  sessions: readonly SessionInfo[],
  messagesOf: (id: string) => readonly SessionMessage[],
): ApprovalNotice[] {
  const out: ApprovalNotice[] = [];
  for (const session of sessions) {
    if (session.status !== "waiting_approval") continue;
    const match = findPendingApproval(messagesOf(session.id), session.status);
    if (!match || !match.tool || match.tool.state.phase !== "waiting_confirmation") continue;
    out.push({
      sessionName: session.name,
      toolName: match.tool.name,
      description: match.tool.state.description ?? match.tool.name,
      approvalId: match.tool.state.approvalId,
    });
  }
  return out;
}

/** Bound a dedupe set — at the cap, drop the oldest half (Sets keep insertion
 * order). Resolved approvals never re-notify, so evicting old ids is harmless. */
export function evictToCap(set: Set<string>, cap: number): void {
  if (set.size < cap) return;
  let drop = set.size - Math.floor(cap / 2);
  for (const id of set) {
    if (drop-- <= 0) break;
    set.delete(id);
  }
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
