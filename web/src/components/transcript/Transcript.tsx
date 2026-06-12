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
import { epochOf, focusedSessionMessages } from "../../state/messages";
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
    if (
      status !== "working" &&
      status !== "thinking" &&
      status !== "tool_running"
    )
      return null;
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

  // Drive the virtualizer off the messages array.
  //
  // `getItemKey` is a STABLE per-message id. tanstack-virtual stores each
  // measured height in `itemSizeCache` keyed by the item key and reads it
  // back by `getItemKey(i)` in getMeasurements. A key that changes on
  // content mutation (the old `messageId:version`) orphans the cached
  // size on every streaming delta, so getMeasurements permanently falls
  // back to estimateSize and every row is mispositioned. A row that grows
  // in place is remeasured by the per-element ResizeObserver under its
  // stable key — no key churn needed, and the new size persists.
  //
  // `measureElement`: rows are absolutely positioned via
  // translateY(item.start), the cumulative sum of measured heights. The
  // core default does Math.round(blockSize): on fractional display
  // scaling / browser zoom (e.g. 96.667px) it can round *down*, so a row
  // reserves less than it paints and the next row's offset lands on top
  // of it (DPI-dependent — "fine on my other laptop"). Ceil so reserved
  // space is always >= painted height. Keeps the ResizeObserver
  // borderBoxSize path intact.
  const virtualizer = createVirtualizer({
    count: messages().length,
    getScrollElement: () => containerRef ?? null,
    estimateSize: () => 96,
    overscan: 8,
    measureElement: (element, entry, instance) => {
      const box = entry?.borderBoxSize?.[0];
      const raw = box
        ? box[instance.options.horizontal ? "inlineSize" : "blockSize"]
        : element.getBoundingClientRect()[
            instance.options.horizontal ? "width" : "height"
          ];
      return Math.ceil(raw);
    },
    getItemKey: (index) => {
      const m = messages()[index];
      if (!m) return index;
      return m.messageId;
    },
  });

  // Push the row COUNT into the virtualizer when messages are appended.
  // `count` is read from the options object at creation, so a plain
  // `createVirtualizer({ count: messages().length })` never updates — we
  // re-apply it here on length change.
  //
  // measure() (which wipes the entire itemSizeCache) is called ONLY on a
  // wholesale content swap — i.e. when the focused session changes and the
  // new session's rows first arrive (scrollback replay). Without this, the
  // virtualizer keeps the previous session's layout / a stale count=0 and
  // the new history doesn't render until an unrelated event (typing in the
  // prompt) forces a relayout. It must NOT run on every streaming delta —
  // that's the old "universal overlap" regression — so we key the remeasure
  // on a session change (sid), never on epoch/length alone.
  let lastMeasuredSid: string | null | undefined;
  let needsRemeasure = false;
  createEffect(() => {
    const sid = focusedSessionId();
    const len = messages().length;
    virtualizer.setOptions({
      ...virtualizer.options,
      count: len,
    });
    if (sid !== lastMeasuredSid) {
      lastMeasuredSid = sid;
      needsRemeasure = true;
    }
    // Remeasure once the swapped-in session actually has rows (scrollback
    // may land a tick after the focus change). Deferred a frame so the new
    // rows are in the DOM before we measure them.
    if (needsRemeasure && len > 0) {
      needsRemeasure = false;
      queueMicrotask(() => virtualizer.measure());
    }
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
      // Expired without finding a match. Drop the jump AND fall
      // through to the auto-scroll-to-bottom that the focus effect
      // skipped (it deferred to us, but we never made it). Without
      // this, switching to a session whose jump expires leaves the
      // user stuck mid-transcript at whatever scroll the previous
      // session had.
      setPendingSearchJump(null);
      setStuckBottom(true);
      queueMicrotask(() => {
        if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
      });
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
              // `count` is pushed to the virtualizer in a separate
              // reactive tick from when measurements recompute, so the
              // store-backed getVirtualItems() can momentarily contain an
              // `undefined` entry (an in-range index whose measurement
              // object doesn't exist yet). Render nothing for that slot;
              // reconcile fills it on the next tick and For re-renders.
              if (!item) return null;
              const m = () => messages()[item.index];
              return (
                <Show when={m()}>
                  {(msg) => (
                    <div
                      data-index={item.index}
                      // virtual-core's measureElement reads `data-index`
                      // off the DOM to map the resize back to an item.
                      // The reactive `data-index={item.index}` above is
                      // applied by Solid in an effect that runs AFTER
                      // this synchronous ref callback — so on the first
                      // (mount-time) measure the attribute isn't there
                      // yet, indexFromElement returns -1, and the
                      // measurement is silently dropped (the row stays
                      // pinned at estimateSize → overlap). Set the
                      // attribute imperatively here, before measuring,
                      // so the very first measure resolves. Each rendered
                      // row maps to a fixed item index for its lifetime
                      // (For + reconcile key:"index"), so this is stable;
                      // the reactive attr still covers any later change.
                      ref={(el) => {
                        el.setAttribute("data-index", String(item.index));
                        virtualizer.measureElement(el);
                      }}
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
