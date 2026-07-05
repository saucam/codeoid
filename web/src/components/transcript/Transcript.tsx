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
import {
  epochOf,
  focusedSessionMessages,
  registerSessionCachePruner,
} from "../../state/messages";
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

  // Snap the scroll viewport to the very bottom (instant).
  function snapToBottom(): void {
    if (containerRef) containerRef.scrollTop = containerRef.scrollHeight;
  }

  // Scroll to the bottom for a discrete event (send / session switch). The
  // continuous re-pinning as content grows or the viewport shrinks is
  // handled by `pinObserver` below — this just kicks the initial scroll,
  // optionally animated.
  function pinToBottom(smooth = false): void {
    if (!containerRef) return;
    queueMicrotask(() => {
      if (!containerRef) return;
      if (smooth) {
        containerRef.scrollTo({
          top: containerRef.scrollHeight,
          behavior: "smooth",
        });
      } else {
        snapToBottom();
      }
    });
  }

  // The robust pin: a single ResizeObserver watching BOTH the scroll
  // viewport AND the content sizer. While the user is stuck to the bottom,
  // re-pin on every size change. This covers two edge cases a one-shot
  // scroll misses:
  //   1. Large / streaming output whose sizer keeps growing for many frames
  //      as rows measure (a fixed-count re-pin falls behind → "stops
  //      scrolling").
  //   2. The WorkerIndicator ("thinking…") appearing below the transcript,
  //      which shrinks the viewport and would otherwise hide the last
  //      message behind it.
  // Pinning sets scrollTop only (never changes element sizes), so it can't
  // feed back into the observer. The `stuckBottom` guard means a user who
  // scrolls up mid-stream is left alone.
  let sizerRef: HTMLDivElement | undefined;
  let pinObserver: ResizeObserver | undefined;
  onMount(() => {
    pinObserver = new ResizeObserver(() => {
      if (stuckBottom()) snapToBottom();
    });
    if (containerRef) pinObserver.observe(containerRef);
    if (sizerRef) pinObserver.observe(sizerRef);
    onCleanup(() => pinObserver?.disconnect());
  });

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
  // Stable per-message item key: `${sessionId}:${messageId}`. Namespacing
  // by session keeps a revisited session's measured heights alive in
  // `itemSizeCache` across switches (the #73 guarantee).
  const itemKeyFor = (index: number): string | number => {
    const sid = focusedSessionId();
    const m = messages()[index];
    if (!m) return index;
    return `${sid ?? ""}:${m.messageId}`;
  };

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
    getItemKey: (index) => itemKeyFor(index),
  });

  // The virtualizer instance is NOT reactive on its own. Verified against
  // the installed @tanstack/virtual-core 3.14.0 + solid-virtual 3.13.24
  // sources (web/node_modules/@tanstack/*/dist/esm/index.js):
  //
  //   - `setOptions()` ONLY assigns `this.options` — it does NOT notify.
  //     (An earlier comment here claimed solid-virtual 3.x notifies
  //     internally on count change; that is false and caused stale
  //     layouts / the size-cache poisoning regression.)
  //   - The solid adapter's `onChange` is the ONLY thing that pushes fresh
  //     `getVirtualItems()` / `getTotalSize()` into the Solid store, and
  //     `onChange` only runs via `notify()`. Absent our call it fires only
  //     from scroll/resize observers — so when scrollTop can't move (both
  //     sessions pinned at bottom, or an unscrollable transcript) nothing
  //     ever syncs.
  //   - `maybeNotify()` is memoized on [isScrolling, range.startIndex,
  //     range.endIndex] and SKIPS the notify when the visible index range
  //     is unchanged — which is exactly the session-switch case (two
  //     sessions pinned at the bottom can have identical ranges). Hence we
  //     call the unconditional `notify(false)` (TS-private, stable public
  //     behavior at runtime) instead. It does NOT touch itemSizeCache, so
  //     measured heights survive — unlike `measure()`, which wipes the
  //     whole cache and re-introduces the #73 overlap bug.
  //   - On a session SWITCH we additionally pass a fresh `getItemKey`
  //     function identity. `getMeasurementOptions` is memoized on
  //     [count, paddingStart, scrollMargin, getItemKey, …]; with an equal
  //     count and the same getItemKey closure it would NOT rebuild
  //     `measurementsCache`, leaving stale entries keyed under the OLD
  //     session's `${sid}:${msgId}` keys. The per-element ResizeObserver
  //     then fires for the new session's rows and `resizeItem()` writes
  //     the NEW row heights under those OLD keys — poisoning the size
  //     cache. A new getItemKey identity forces `getMeasurements` to
  //     rebuild every measurement from `itemSizeCache` under the NEW keys
  //     (cache hits for previously-visited sessions, estimateSize for
  //     fresh ones) WITHOUT clearing any cached sizes.
  //
  // Timing: this createEffect runs in the same synchronous batch as the
  // render that swaps row content, while ResizeObserver callbacks fire at
  // the following frame boundary — so measurement keys are already correct
  // by the time the first resize lands.
  let prevLen = -1;
  let prevSid: string | null | undefined = undefined;
  createEffect(() => {
    const len = messages().length;
    const sid = focusedSessionId();
    const sessionChanged = prevSid === undefined || sid !== prevSid;
    const countChanged = len !== prevLen;
    prevSid = sid;
    prevLen = len;
    if (!sessionChanged && !countChanged) return;
    virtualizer.setOptions({
      ...virtualizer.options,
      count: len,
      // Fresh function identity on session switch only — see comment above.
      ...(sessionChanged ? { getItemKey: (i: number) => itemKeyFor(i) } : {}),
    });
    (virtualizer as unknown as { notify: (sync: boolean) => void }).notify(
      false,
    );
  });

  // When a session is DESTROYED (not merely switched away from), drop its
  // cached row heights — the `${sid}:` keys can never be read again and
  // would otherwise accumulate forever. In-place deletion is intentional:
  // `getMeasurements` is memoized on the itemSizeCache Map REFERENCE, so
  // pruning dead keys doesn't force a relayout of the live session.
  onMount(() => {
    const unregister = registerSessionCachePruner((sid) => {
      const prefix = `${sid}:`;
      const core = virtualizer as unknown as {
        itemSizeCache: Map<string | number, number>;
      };
      for (const key of [...core.itemSizeCache.keys()]) {
        if (typeof key === "string" && key.startsWith(prefix)) {
          core.itemSizeCache.delete(key);
        }
      }
      // `measureElement(null)` is virtual-core's documented prune path: it
      // unobserves + evicts every elementsCache entry whose DOM node is no
      // longer connected (covers rows of the destroyed session).
      virtualizer.measureElement(null);
    });
    onCleanup(unregister);
  });

  // Coalesced elementsCache sweep — used by the per-row onCleanup below.
  let prunePending = false;
  function scheduleElementsCachePrune(): void {
    if (prunePending) return;
    prunePending = true;
    queueMicrotask(() => {
      prunePending = false;
      // Safe post-disposal too: this only iterates the cache and unobserves
      // disconnected nodes.
      virtualizer.measureElement(null);
    });
  }

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
        pinToBottom(smooth);
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
      pinToBottom(false);
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
          ref={(el) => {
            sizerRef = el;
            pinObserver?.observe(el);
          }}
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
                        // Solid never calls refs with null on unmount, so
                        // without this the virtualizer's elementsCache (and
                        // its ResizeObserver registrations) would retain
                        // every unmounted row's DOM subtree forever — keys
                        // are unique per message, so nothing ever evicts.
                        // virtual-core's `measureElement(null)` prunes all
                        // entries whose node is disconnected; defer to a
                        // microtask because onCleanup runs BEFORE Solid
                        // detaches the node (isConnected is still true
                        // here), and coalesce so a burst of unmounts does
                        // one cache sweep, not one per row.
                        onCleanup(() => scheduleElementsCachePrune());
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
