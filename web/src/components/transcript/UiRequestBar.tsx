/**
 * Provider-dialog bar — renders the oldest pending `session.ui_request`
 * for the focused session, above the prompt (same slot family as
 * ApprovalBar, which handles tool approvals; this handles the generic
 * dialogs a provider/extension raises via `requestUserInput`).
 *
 * One dialog at a time: the daemon settles each request independently, and
 * the store keeps them oldest-first, so answering the head reveals the next.
 * `timeoutMs` requests show a live countdown — the DAEMON enforces the
 * deadline (auto-cancel); the countdown here is display only.
 */

import {
  Component,
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import type { SessionUiRequestMsg } from "../../protocol/types";
import { focusedSessionId } from "../../state/sessions";
import { pendingUiRequest, respondToUiRequest } from "../../state/ui-requests";

const UiRequestBar: Component = () => {
  const pending = createMemo(() => pendingUiRequest(focusedSessionId()));
  return (
    // `keyed` so a DIFFERENT request replacing the current one remounts the
    // card — the card's answer state (text, selection, countdown) must never
    // leak from one request into the next.
    <Show when={pending()} keyed>
      {(req) => <RequestCard req={req} />}
    </Show>
  );
};

const RequestCard: Component<{ req: SessionUiRequestMsg }> = (props) => {
  // One-shot init is safe: the parent <Show keyed> remounts this card per
  // request, so props.req never changes identity within a mount.
  // eslint-disable-next-line solid/reactivity
  const [text, setText] = createSignal(props.req.prefill ?? "");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [remainingMs, setRemainingMs] = createSignal<number | null>(null);

  // Display-only countdown for timed dialogs; the daemon auto-cancels and
  // broadcasts ui_resolved on expiry, which unmounts this card.
  createEffect(() => {
    const timeoutMs = props.req.timeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) {
      setRemainingMs(null);
      return;
    }
    const deadline = Date.parse(props.req.timestamp) + timeoutMs;
    const tick = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    onCleanup(() => clearInterval(timer));
  });

  const submitValue = (value: string) =>
    respondToUiRequest(props.req.sessionId, props.req.requestId, { value });
  const cancel = () =>
    respondToUiRequest(props.req.sessionId, props.req.requestId, { cancelled: true });

  return (
    <div
      class="border-t border-accent/40 bg-accent/[0.06] px-4 py-3"
      data-testid="ui-request-bar"
    >
      <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-accent">
        <span>❓</span>
        <span class="font-semibold">{props.req.title}</span>
        <Show when={remainingMs() !== null}>
          <span class="ml-auto font-mono text-fg-muted" data-testid="ui-request-countdown">
            {Math.ceil((remainingMs() ?? 0) / 1000)}s
          </span>
        </Show>
      </div>
      <Show when={props.req.message}>
        <div class="mb-2 text-sm text-fg">{props.req.message}</div>
      </Show>

      <Switch>
        <Match when={props.req.method === "confirm"}>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded bg-accent px-3 py-1 text-sm font-semibold text-bg hover:opacity-90"
              onClick={() => respondToUiRequest(props.req.sessionId, props.req.requestId, { confirmed: true })}
            >
              Yes
            </button>
            <button
              type="button"
              class="rounded border border-border px-3 py-1 text-sm text-fg hover:bg-bg-active"
              onClick={() => respondToUiRequest(props.req.sessionId, props.req.requestId, { confirmed: false })}
            >
              No
            </button>
            <CancelButton onCancel={cancel} />
          </div>
        </Match>

        <Match when={props.req.method === "select"}>
          <div class="space-y-1">
            <For each={props.req.options ?? []}>
              {(option) => (
                <label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-fg hover:bg-bg-active/50">
                  <input
                    type="radio"
                    name={`ui-select-${props.req.requestId}`}
                    checked={selected() === option}
                    onChange={() => setSelected(option)}
                  />
                  <span>{option}</span>
                </label>
              )}
            </For>
            <div class="mt-2 flex gap-2">
              <button
                type="button"
                class="rounded bg-accent px-3 py-1 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-40"
                disabled={selected() === null}
                onClick={() => {
                  const value = selected();
                  if (value !== null) submitValue(value);
                }}
              >
                Choose
              </button>
              <CancelButton onCancel={cancel} />
            </div>
          </div>
        </Match>

        <Match when={props.req.method === "input"}>
          <form
            class="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitValue(text());
            }}
          >
            <input
              type="text"
              class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg"
              placeholder={props.req.placeholder ?? ""}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <button
              type="submit"
              class="rounded bg-accent px-3 py-1 text-sm font-semibold text-bg hover:opacity-90"
            >
              Submit
            </button>
            <CancelButton onCancel={cancel} />
          </form>
        </Match>

        <Match when={props.req.method === "editor"}>
          <div class="space-y-2">
            <textarea
              class="h-32 w-full rounded border border-border bg-bg px-2 py-1 font-mono text-sm text-fg"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            <div class="flex gap-2">
              <button
                type="button"
                class="rounded bg-accent px-3 py-1 text-sm font-semibold text-bg hover:opacity-90"
                onClick={() => submitValue(text())}
              >
                Submit
              </button>
              <CancelButton onCancel={cancel} />
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );
};

const CancelButton: Component<{ onCancel: () => void }> = (props) => (
  <button
    type="button"
    class="ml-auto rounded border border-border px-3 py-1 text-sm text-fg-muted hover:bg-bg-active"
    onClick={() => props.onCancel()}
  >
    Dismiss
  </button>
);

export default UiRequestBar;
