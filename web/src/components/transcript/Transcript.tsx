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
  Match,
  Show,
  Switch,
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
  attachError,
  attachState,
  hasOlderHistory,
  loadOlderHistory,
  pagingBusy,
  pagingError,
  requestAttachRetry,
} from "../../state/attach";
import {
  findJumpTarget,
  pendingSearchJump,
  setPendingSearchJump,
} from "../../state/search-jump";

const SCROLL_STICKY_THRESHOLD_PX = 80;

/**
 * Anchored-prepend scroll math (#152): after older history is inserted at
 * the TOP of the scroll content, keep the viewport visually still by
 * preserving the distance from the scroll position to the BOTTOM of the
 * content (`prevHeight - prevTop`), which prepending cannot change.
 * Exported for unit tests — jsdom has no real layout, so the arithmetic is
 * what gets asserted.
 */
export function computeAnchoredScrollTop(
  prevHeight: number,
  prevTop: number,
  newHeight: number,
): number {
  return newHeight - (prevHeight - prevTop);
}

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

  // ---------- older-history backfill (#152) ----------

  // Anchored prepend: capture scroll geometry synchronously around the store
  // mutation (attach.ts brackets the prepend with these hooks — capturing
  // before the network await would go stale if the user keeps scrolling).
  // The restore runs twice: synchronously after Solid's reactive flush (the
  // virtualizer count-push effect has already resized the sizer with
  // estimated heights — set scrollTop before paint so there's no flicker),
  // and again on the next frame. The rAF pass recomputes the same
  // "distance-to-bottom" invariant, so it composes with (rather than fights)
  // virtual-core's own resizeItem scroll adjustment, which corrects for
  // prepended rows re-measuring from estimateSize to their real heights.
  // When the user is stuck to the bottom (tiny transcript auto-filling), the
  // sticky pinObserver owns the scroll — anchoring stays out of the way.
  function loadOlder(): void {
    const sid = focusedSessionId();
    if (!sid) return;
    let prevHeight = 0;
    let prevTop = 0;
    void loadOlderHistory(sid, {
      onBeforePrepend: () => {
        prevHeight = containerRef?.scrollHeight ?? 0;
        prevTop = containerRef?.scrollTop ?? 0;
      },
      onAfterPrepend: () => {
        const apply = (): void => {
          if (!containerRef || stuckBottom()) return;
          containerRef.scrollTop = computeAnchoredScrollTop(
            prevHeight,
            prevTop,
            containerRef.scrollHeight,
          );
        };
        apply();
        requestAnimationFrame(apply);
      },
    });
  }

  // Auto-trigger when the sentinel scrolls into view. Environment-safe:
  // without IntersectionObserver the sentinel falls back to click-to-load
  // only. Single-flight is enforced inside loadOlderHistory. The sentinel
  // element flows through a SIGNAL (not a bare ref) because its <Show> can
  // mount it during the first render — BEFORE onMount has created the
  // observer — and again on any later hasOlderHistory flip; the effect below
  // re-observes whichever element is current, whenever both exist.
  const [sentinelEl, setSentinelEl] = createSignal<HTMLElement | null>(null);
  onMount(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const historyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadOlder();
        }
      },
      { root: containerRef ?? null },
    );
    createEffect(() => {
      const el = sentinelEl();
      if (!el) return;
      historyObserver.observe(el);
      onCleanup(() => historyObserver.unobserve(el));
    });
    onCleanup(() => historyObserver.disconnect());
  });

  const focusedAttachState = () => attachState(focusedSessionId());
  const focusedAttachError = () => attachError(focusedSessionId());
  const focusedHasOlder = () => hasOlderHistory(focusedSessionId());
  const focusedPagingBusy = () => pagingBusy(focusedSessionId());
  const focusedPagingError = () => pagingError(focusedSessionId());

  function retryAttach(): void {
    const sid = focusedSessionId();
    if (sid) requestAttachRetry(sid);
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      class="min-h-0 flex-1 overflow-y-auto px-4 py-3"
    >
      <Show
        when={messages().length > 0}
        fallback={
          // Empty transcript — but "empty" has three distinct truths (#152):
          // a replay still in flight (don't invite typing into a session we
          // haven't attached), a failed attach (surface it + retry), and a
          // genuinely message-less session.
          <div class="flex h-full items-center justify-center text-sm text-fg-muted">
            <Switch
              fallback={<p>No messages yet — type below and press Enter.</p>}
            >
              <Match when={focusedAttachState() === "pending"}>
                <p>
                  <span class="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />{" "}
                  loading transcript…
                </p>
              </Match>
              <Match when={focusedAttachState() === "failed"}>
                <div class="flex flex-col items-center gap-2">
                  <p class="text-danger">
                    Couldn't attach to this session
                    {focusedAttachError() ? `: ${focusedAttachError()}` : "."}
                  </p>
                  <button
                    type="button"
                    onClick={retryAttach}
                    class="rounded border border-accent/40 px-3 py-1 text-xs text-accent hover:bg-bg-active"
                  >
                    Retry
                  </button>
                </div>
              </Match>
            </Switch>
          </div>
        }
      >
        {/* Re-attach failure with an existing transcript (reconnect path):
            the messages stay useful, but surface the error inline instead of
            only console.warn — the session isn't receiving updates. */}
        <Show when={focusedAttachState() === "failed"}>
          <div class="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-2 rounded border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger">
            <span>
              Attach failed
              {focusedAttachError() ? `: ${focusedAttachError()}` : "."}
            </span>
            <button
              type="button"
              onClick={retryAttach}
              class="shrink-0 rounded border border-danger/40 px-2 py-0.5 hover:bg-danger/20"
            >
              Retry
            </button>
          </div>
        </Show>
        {/* Older-history sentinel: rendered ABOVE the virtualized list while
            the daemon reports more history (`tail`+`hasMore`). Click loads a
            page; scrolling it into view auto-loads via IntersectionObserver.
            Lives OUTSIDE the absolutely-positioned sizer so it takes part in
            normal flow — prepends below it shift content, which the anchored
            scroll restore in loadOlder() compensates for. */}
        <Show when={focusedHasOlder()}>
          <div
            ref={(el) => {
              setSentinelEl(el);
              // Solid never calls refs with null on unmount — clear by hand
              // so the observer effect releases the detached node.
              onCleanup(() => setSentinelEl(null));
            }}
            class="mx-auto w-full max-w-3xl pb-2 text-center text-xs text-fg-muted"
            data-testid="older-history-sentinel"
          >
            <Switch
              fallback={
                <button
                  type="button"
                  onClick={loadOlder}
                  class="rounded border border-border px-3 py-1 hover:bg-bg-active hover:text-fg"
                >
                  ↑ older messages — scroll or click to load
                </button>
              }
            >
              <Match when={focusedPagingBusy()}>
                <span>
                  <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />{" "}
                  loading older…
                </span>
              </Match>
              <Match when={focusedPagingError()}>
                <span class="text-danger">
                  Couldn't load older messages: {focusedPagingError()}{" "}
                  <button
                    type="button"
                    onClick={loadOlder}
                    class="rounded border border-danger/40 px-2 py-0.5 hover:bg-danger/20"
                  >
                    Retry
                  </button>
                </span>
              </Match>
            </Switch>
          </div>
        </Show>
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
