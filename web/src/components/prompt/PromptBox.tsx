/**
 * Multi-line prompt with persistent drafts. Enter sends; Shift+Enter
 * inserts a newline; Ctrl+Enter also sends (common alt). Slash commands
 * starting with `/` are intercepted client-side: `/new`, `/rename`,
 * `/destroy`, `/rotate`, `/interrupt`, `/mode`, `/model`. Everything else
 * goes to the daemon as a `session.send`.
 */

import {
  Component,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { newRequestId, send } from "../../state/connection";
import {
  clearDraft,
  getDraft,
  setDraft,
} from "../../state/prompt-drafts";
import {
  focusedSession,
  focusedSessionId,
  removeSession,
} from "../../state/sessions";
import { openIdentityDrawer } from "../IdentityDrawer";
import { dispatchSlash, parseSlash } from "./slash";

const PromptBox: Component = () => {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const draftKey = () => focusedSessionId() ?? "__none__";

  // Hydrate from the persisted draft on session change.
  function hydrate() {
    setText(getDraft(draftKey()));
    autosize();
  }

  onMount(() => {
    hydrate();
    const onFocus = () => textareaRef?.focus();
    window.addEventListener("codeoid:focus-prompt", onFocus);
    onCleanup(() =>
      window.removeEventListener("codeoid:focus-prompt", onFocus),
    );
  });

  // Re-hydrate from localStorage when the focused session id changes.
  createEffect(on(focusedSessionId, () => hydrate()));

  function autosize(): void {
    const el = textareaRef;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  function handleInput(ev: InputEvent & { currentTarget: HTMLTextAreaElement }): void {
    setError(null);
    setText(ev.currentTarget.value);
    setDraft(draftKey(), ev.currentTarget.value);
    autosize();
  }

  function submit(): void {
    const session = focusedSession();
    if (!session) {
      setError("no session focused");
      return;
    }
    const raw = text().trim();
    if (!raw) return;

    // Slash commands intercepted client-side.
    const slash = parseSlash(raw);
    if (slash) {
      try {
        dispatchSlash(slash, {
          sessionId: session.id,
          send,
          newRequestId,
          removeSession,
          showIdentity: openIdentityDrawer,
          // showHelp left undefined for now — wired in P7 alongside the
          // help modal.
        });
        clearDraft(draftKey());
        setText("");
        autosize();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    send({
      type: "session.send",
      id: newRequestId(),
      sessionId: session.id,
      text: raw,
    });
    clearDraft(draftKey());
    setText("");
    autosize();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      submit();
      return;
    }
    if (ev.key === "Enter" && ev.ctrlKey) {
      ev.preventDefault();
      submit();
    }
  }

  return (
    <footer class="border-t border-border bg-bg-elev/60 px-4 py-3">
      <div class="mx-auto max-w-3xl space-y-1">
        <div class="flex items-end gap-2 rounded border border-border bg-bg px-3 py-2 focus-within:border-accent">
          <textarea
            ref={textareaRef}
            value={text()}
            onInput={handleInput}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={
              focusedSession()
                ? "Message Claude…  Enter sends · Shift+Enter for newline · /help for commands"
                : "Select or create a session first."
            }
            class="flex-1 resize-none bg-transparent font-mono text-sm leading-6 text-fg outline-none placeholder:text-fg-faint"
            disabled={!focusedSession()}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text().trim() || !focusedSession()}
            class="self-end rounded bg-accent px-3 py-1 text-xs font-semibold text-bg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            title="Send (Enter)"
          >
            send
          </button>
        </div>
        <Show when={error()}>
          <div class="px-1 text-[11px] text-danger">{error()}</div>
        </Show>
        <div class="px-1 text-[10px] text-fg-faint">
          /new {"<name>"} {"[workdir]"} · /rename {"<name>"} · /interrupt ·
          /rotate · /mode {"<i|a|x>"} · /model {"<id>"} · /who · /destroy
        </div>
      </div>
    </footer>
  );
};

export default PromptBox;
