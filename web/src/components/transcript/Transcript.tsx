/**
 * Transcript pane. Renders the focused session's messages with auto
 * scroll-to-bottom on new content unless the user has scrolled up. Tool
 * approval bars appear inline; top-level approvals can also surface in
 * the prompt area.
 *
 * Virtualized via @tanstack/solid-virtual so a 5 000-message bash-heavy
 * session doesn't melt the renderer. The virtualizer measures each row
 * dynamically (heights vary wildly: a 2-line user message vs. a
 * 200-line bash output) and rebuilds its index when the message list
 * changes. Streaming deltas mutate row content in place; we wire the
 * per-session epoch into the virtualizer's `getItemKey` so it
 * remeasures the affected row without thrashing the rest.
 */

import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";

import MessageRow from "./MessageRow";
import { epochOf, focusedSessionMessages, versionOf } from "../../state/messages";
import { focusedSession, focusedSessionId } from "../../state/sessions";
import {
  findJumpTarget,
  pendingSearchJump,
  setPendingSearchJump,
} from "../../state/search-jump";

const SCROLL_STICKY_THRESHOLD_PX = 80;

const Transcript: Component = () => {
  const messages = focusedSessionMessages;
  let containerRef: HTMLDivElement | undefined;
  const [stuckBottom, setStuckBottom] = createSignal(true);

  // One-shot smoothing — set when the user just submitted a message so
  // the next auto-scroll uses behavior: "smooth" instead of an instant
  // snap. We don't animate every streaming delta because that's
  // visually busy and creates lag perception.
  let smoothNext = false;
  function listener(ev: Event): void {
    void ev;
    smoothNext = true;
  }
  onMount(() => {
    window.addEventListener("codeoid:smooth-scroll", listener);
    onCleanup(() =>
      window.removeEventListener("codeoid:smooth-scroll", listener),
    );
  });

  // Pinpoint the messageId currently being streamed by the assistant —
  // if any. We render a caret on that one so the user has a clear "still
  // typing" cue at the actual end of the text. Logic: session is busy
  // (thinking | tool_running) AND there's a trailing assistant message
  // that hasn't transitioned to a terminal role yet.
  const streamingMessageId = createMemo<string | null>(() => {
    const status = focusedSession()?.status;
    if (status !== "thinking" && status !== "tool_running") return null;
    const arr = messages();
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i];
      if (!m) continue;
      if (m.role === "assistant" || m.role === "thinking") return m.messageId;
      // Tool calls / results between user and final assistant are fine —
      // keep walking up to the assistant if there is one.
      if (m.role === "user") return null;
    }
    return null;
  });

  function isAtBottom(el: HTMLDivElement): boolean {
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    return remaining <= SCROLL_STICKY_THRESHOLD_PX;
  }

  function handleScroll(): void {
    if (!containerRef) return;
    setStuckBottom(isAtBottom(containerRef));
  }

  // Drive the virtualizer off the messages array. `getItemKey` blends
  // messageId + version so streaming deltas (which mutate content in
  // place — same id, bumped version) cause that one row to remeasure
  // without invalidating its neighbours.
  const virtualizer = createVirtualizer({
    count: messages().length,
    getScrollElement: () => containerRef ?? null,
    estimateSize: () => 96,
    overscan: 8,
    getItemKey: (index) => {
      const m = messages()[index];
      if (!m) return index;
      return `${m.messageId}:${versionOf(m.messageId)}`;
    },
  });

  // Re-sync the virtualizer when the messages array length changes.
  // The virtualizer reads `count` from its options on creation; we
  // need to push updates explicitly when messages stream in.
  createEffect(() => {
    const len = messages().length;
    epochOf(focusedSessionId()); // re-fire on in-place mutations too
    virtualizer.setOptions({
      ...virtualizer.options,
      count: len,
    });
    queueMicrotask(() => virtualizer.measure());
  });

  // Auto-scroll on new content, but only if the user was already at
  // the bottom. We track BOTH the messages signal AND the per-session
  // epoch so streaming deltas (which mutate fields in place — array
  // ref unchanged) still re-trigger this effect.
  const scrollTrigger = () => {
    const arr = messages();
    const epoch = epochOf(focusedSessionId());
    return [arr, epoch] as const;
  };
  createEffect(
    on(scrollTrigger, () => {
      if (!containerRef) return;
      if (stuckBottom()) {
        const smooth = smoothNext;
        smoothNext = false;
        // Defer one frame so the new DOM has measured.
        queueMicrotask(() => {
          if (!containerRef) return;
          if (smooth) {
            containerRef.scrollTo({
              top: containerRef.scrollHeight,
              behavior: "smooth",
            });
          } else {
            containerRef.scrollTop = containerRef.scrollHeight;
          }
        });
      }
    }),
  );

  // When the focused session changes, snap to bottom (no animation —
  // we're swapping content wholesale). Skipped when a search jump is
  // queued for that exact session — the jump effect below will scroll
  // to the matching message instead.
  createEffect(
    on(focusedSessionId, () => {
      const jump = pendingSearchJump();
      const sid = focusedSessionId();
      if (jump && jump.sessionId === sid) return;
      setStuckBottom(true);
      smoothNext = false;
      queueMicrotask(() => {
        if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
      });
    }),
  );

  // Search jump: when SearchModal queues a target for this session, look
  // up the matching messageId and scroll its row into view. Goes through
  // virtualizer.scrollToIndex so the item gets mounted before we try
  // to add the flash class.
  createEffect(() => {
    const jump = pendingSearchJump();
    if (!jump) return;
    const sid = focusedSessionId();
    if (!sid || jump.sessionId !== sid) return;
    if (Date.now() - jump.setAt > 4000) {
      setPendingSearchJump(null);
      return;
    }
    const arr = messages();
    if (arr.length === 0) return;
    const targetId = findJumpTarget(arr, jump);
    if (!targetId) return;
    const idx = arr.findIndex((m) => m.messageId === targetId);
    if (idx < 0) return;
    setPendingSearchJump(null);
    setStuckBottom(false);
    virtualizer.scrollToIndex(idx, { align: "center", behavior: "smooth" });
    // Wait for the row to be mounted by the virtualizer (next 2
    // frames is usually enough for measure + layout).
    let attempts = 0;
    const tryFlash = () => {
      if (!containerRef) return;
      const row = containerRef.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(targetId)}"]`,
      );
      if (row) {
        row.classList.add("search-jump-flash");
        setTimeout(() => row.classList.remove("search-jump-flash"), 1800);
        return;
      }
      if (attempts++ < 20) {
        requestAnimationFrame(tryFlash);
      }
    };
    requestAnimationFrame(tryFlash);
  });

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
        <div
          class="relative mx-auto w-full max-w-3xl"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(item) => {
              const m = () => messages()[item.index];
              return (
                <Show when={m()}>
                  {(msg) => (
                    <div
                      data-index={item.index}
                      // Hand the element directly to the virtualizer's
                      // ResizeObserver. The previous `queueMicrotask`
                      // wrap caused first-frame measurements to land
                      // before layout (heights came back as 0 / the
                      // estimateSize default), so streaming markdown
                      // rows mounted with the wrong bounds and the
                      // virtualizer's spacer math jittered for the
                      // first few deltas. ResizeObserver picks up
                      // subsequent growth automatically — no manual
                      // remeasure needed even as the row swells.
                      ref={(el) => virtualizer.measureElement(el)}
                      class="absolute left-0 top-0 w-full pb-2"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <MessageRow
                        msg={msg()}
                        streaming={msg().messageId === streamingMessageId()}
                      />
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
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
