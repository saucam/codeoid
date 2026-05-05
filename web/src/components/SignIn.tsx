/**
 * Sign-in surface — shown when no API key is remembered, or when bootstrap
 * failed because the saved key is invalid / expired. Trades the user's
 * ZeroID API key (`zid_sk_…`) for a daemon JWT via ZeroID's
 * `/oauth2/token` endpoint.
 *
 * The advanced section lets the user override the ZeroID URL (for staging
 * / dev environments). The daemon URL stays implicit — it's read from
 * VITE_CODEOID_URL on bootstrap.
 */

import { Component, Show, createSignal } from "solid-js";

import { rememberApiKey, rememberedApiKey } from "../lib/auth";
import { bootstrap, bootstrapError } from "../state/connection";

const SignIn: Component<{ onSignedIn: () => void }> = (props) => {
  const [apiKey, setApiKey] = createSignal(rememberedApiKey() ?? "");
  const [busy, setBusy] = createSignal(false);
  const [advanced, setAdvanced] = createSignal(false);
  const [zeroidUrl, setZeroidUrl] = createSignal(
    (import.meta.env.VITE_ZEROID_URL as string | undefined) ?? "http://localhost:8899",
  );

  async function submit(ev: Event): Promise<void> {
    ev.preventDefault();
    if (busy()) return;
    const key = apiKey().trim();
    if (!key) return;
    setBusy(true);
    try {
      rememberApiKey(key);
      await bootstrap({ apiKey: key });
      props.onSignedIn();
    } catch {
      // bootstrapError signal carries the message — the form below renders it.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex h-full items-center justify-center bg-bg p-8">
      <form
        onSubmit={submit}
        class="w-full max-w-md space-y-5 rounded-lg border border-border bg-bg-elev p-7 shadow-2xl"
      >
        <header class="space-y-1">
          <h1 class="text-xl font-semibold tracking-tight text-fg">Codeoid</h1>
          <p class="text-sm text-fg-muted">
            Sign in with your ZeroID API key to connect to the daemon.
          </p>
        </header>

        <label class="block space-y-1.5">
          <span class="text-xs font-medium uppercase tracking-wider text-fg-faint">
            ZeroID API key
          </span>
          <input
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder="zid_sk_…"
            value={apiKey()}
            onInput={(e) => setApiKey(e.currentTarget.value)}
            class="w-full rounded border border-border bg-bg px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            disabled={busy()}
          />
        </label>

        <button
          type="button"
          class="text-xs text-fg-faint underline-offset-2 hover:text-fg-muted hover:underline"
          onClick={() => setAdvanced(!advanced())}
        >
          {advanced() ? "Hide advanced" : "Advanced"}
        </button>

        <Show when={advanced()}>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium uppercase tracking-wider text-fg-faint">
              ZeroID URL
            </span>
            <input
              type="text"
              spellcheck={false}
              value={zeroidUrl()}
              onInput={(e) => setZeroidUrl(e.currentTarget.value)}
              class="w-full rounded border border-border bg-bg px-3 py-2 font-mono text-xs text-fg outline-none focus:border-accent"
              disabled={busy()}
            />
            <p class="text-[11px] text-fg-faint">
              Note: change requires a page reload (set VITE_ZEROID_URL at build time).
            </p>
          </label>
        </Show>

        <Show when={bootstrapError()}>
          <div class="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {bootstrapError()}
          </div>
        </Show>

        <button
          type="submit"
          disabled={busy() || !apiKey().trim()}
          class="w-full rounded bg-accent px-3 py-2 text-sm font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy() ? "Connecting…" : "Sign in"}
        </button>

        <p class="text-[11px] text-fg-faint">
          Your key is stored locally in your browser only — never sent anywhere except
          to ZeroID for token exchange.
        </p>
      </form>
    </div>
  );
};

export default SignIn;
