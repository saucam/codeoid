/**
 * Transcript pane. Renders the focused session's messages with auto
 * scroll-to-bottom on new content unless the user has scrolled up. Tool
 * approval bars appear inline; top-level approvals can also surface in
 * the prompt area.
 *
 * P3 keeps it un-virtualized for simplicity; P7 swaps in
 * @tanstack/solid-virtual once the visible perf pressure is real.
 */

import { Component, For, Show, createEffect, createSignal, on } from "solid-js";

import MessageRow from "./MessageRow";
import { createMessages } from "../../state/messages";
import { focusedSessionId } from "../../state/sessions";

const SCROLL_STICKY_THRESHOLD_PX = 80;

const Transcript: Component = () => {
  const messages = createMessages(focusedSessionId);
  let containerRef: HTMLDivElement | undefined;
  const [stuckBottom, setStuckBottom] = createSignal(true);

  function isAtBottom(el: HTMLDivElement): boolean {
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    return remaining <= SCROLL_STICKY_THRESHOLD_PX;
  }

  function handleScroll(): void {
    if (!containerRef) return;
    setStuckBottom(isAtBottom(containerRef));
  }

  // Auto-scroll on new content, but only if the user was already at the bottom.
  createEffect(
    on(messages, () => {
      if (!containerRef) return;
      if (stuckBottom()) {
        // Defer one frame so the new DOM has measured.
        queueMicrotask(() => {
          if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
        });
      }
    }),
  );

  // When the focused session changes, snap to bottom.
  createEffect(
    on(focusedSessionId, () => {
      setStuckBottom(true);
      queueMicrotask(() => {
        if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
      });
    }),
  );

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      class="min-h-0 flex-1 overflow-y-auto px-4 py-3"
    >
      <Show
        when={messages().length > 0}
        fallback={
          <div class="flex h-full items-center justify-center text-sm text-fg-muted">
            <p>No messages yet — type below and press Enter.</p>
          </div>
        }
      >
        <ol class="mx-auto flex max-w-3xl flex-col gap-2">
          <For each={messages()}>{(m) => <MessageRow msg={m} />}</For>
        </ol>
      </Show>
      <Show when={!stuckBottom()}>
        <ScrollLatchPill onClick={() => {
          setStuckBottom(true);
          if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
        }} />
      </Show>
    </div>
  );
};

const ScrollLatchPill: Component<{ onClick: () => void }> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class="pointer-events-auto sticky bottom-2 mx-auto flex translate-y-0 items-center gap-1 rounded-full border border-accent/40 bg-bg-elev px-3 py-1 text-xs text-accent shadow-lg transition hover:bg-bg-active"
  >
    ↓ jump to latest
  </button>
);

export default Transcript;
