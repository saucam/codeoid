/**
 * App entrypoint. Owns the auth gate: while there's no live `auth.ok`
 * from the daemon, render `<SignIn>`; once authenticated, hand off to the
 * three-pane `<Shell>`.
 *
 * Auto-bootstrap behaviour: if a previously-remembered API key exists in
 * localStorage, attempt the connect on mount. The user only sees the
 * sign-in form when there's no key OR the saved key is rejected.
 */

import { Component, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";

import { rememberedApiKey } from "./lib/auth";
import SignIn from "./components/SignIn";
import Shell from "./components/Shell";
import {
  authIdentity,
  bootstrap,
  newRequestId,
  send,
} from "./state/connection";
import { focusedSession, focusedSessionId } from "./state/sessions";
import { resetClaudeConfig } from "./state/claude-config";
import { installApprovalNotifications } from "./state/desktop-notifications";

const App: Component = () => {
  const [tried, setTried] = createSignal(false);

  // Wire desktop-notification watcher once. It self-checks for
  // permission + tab visibility before firing so it stays quiet by
  // default — the `Enable notifications` button in the status bar is
  // what actually requests permission.
  installApprovalNotifications();

  onMount(async () => {
    const saved = rememberedApiKey();
    if (saved) {
      try {
        await bootstrap({ apiKey: saved });
      } catch {
        // bootstrap surfaces the reason via bootstrapError; SignIn renders it.
      }
    }
    setTried(true);
  });

  // Attach to the focused session whenever it changes (or when we first
  // sign in). The daemon only broadcasts to attached clients — without
  // this we'd see the list but no transcript or streaming deltas.
  const attached = new Set<string>();
  createEffect(
    on([authIdentity, focusedSessionId], () => {
      const auth = authIdentity();
      const id = focusedSessionId();
      if (!auth || !id || attached.has(id)) return;
      try {
        send({ type: "session.attach", id: newRequestId(), sessionId: id });
        attached.add(id);
      } catch (err) {
        console.warn("[codeoid] attach failed:", err);
      }
    }),
  );

  // Drop the cached claude-config snapshot when the focused session
  // changes — the next time the user opens the drawer, we refetch.
  createEffect(
    on(focusedSessionId, (sid, prev) => {
      if (prev !== undefined && prev !== sid) resetClaudeConfig();
    }),
  );

  // Global Ctrl+X (or Cmd+X on macOS) — interrupt the focused session if
  // it's mid-turn. We swallow the event before it bubbles into the prompt
  // textarea, which would otherwise eat the shortcut as a clipboard cut.
  // No-op when no session is busy or focus is in an editable field that
  // would conflict with a real cut intent (input/textarea with selection).
  onMount(() => {
    function onKey(ev: KeyboardEvent): void {
      if (ev.key.toLowerCase() !== "x") return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const s = focusedSession();
      if (!s) return;
      if (s.status !== "thinking" && s.status !== "tool_running") return;

      // Don't hijack a real "cut" the user intended. If the active element
      // is a text field with a non-empty selection, defer to the browser.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        const ta = el as HTMLInputElement | HTMLTextAreaElement;
        if (
          typeof ta.selectionStart === "number" &&
          typeof ta.selectionEnd === "number" &&
          ta.selectionEnd > ta.selectionStart
        ) {
          return;
        }
      }

      ev.preventDefault();
      send({ type: "session.interrupt", id: newRequestId(), sessionId: s.id });
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show
      when={authIdentity()}
      fallback={
        // Avoid a flash of SignIn before the silent auto-bootstrap completes.
        <Show when={tried()} fallback={<BootSplash />}>
          <SignIn onSignedIn={() => undefined} />
        </Show>
      }
    >
      <Shell />
    </Show>
  );
};

const BootSplash: Component = () => (
  <div class="flex h-full items-center justify-center bg-bg">
    <span class="font-mono text-sm text-fg-faint">
      <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />{" "}
      &nbsp;codeoid · connecting…
    </span>
  </div>
);

export default App;
