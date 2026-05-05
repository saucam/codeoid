/**
 * App entrypoint. Owns the auth gate: while there's no live `auth.ok`
 * from the daemon, render `<SignIn>`; once authenticated, hand off to the
 * three-pane `<Shell>`.
 *
 * Auto-bootstrap behaviour: if a previously-remembered API key exists in
 * localStorage, attempt the connect on mount. The user only sees the
 * sign-in form when there's no key OR the saved key is rejected.
 */

import { Component, Show, createSignal, onMount } from "solid-js";

import { rememberedApiKey } from "./lib/auth";
import SignIn from "./components/SignIn";
import Shell from "./components/Shell";
import { authIdentity, bootstrap } from "./state/connection";

const App: Component = () => {
  const [tried, setTried] = createSignal(false);

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
