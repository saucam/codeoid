/**
 * Shared coarse clock — one module-level signal bumped every 30 s by a
 * single interval. Relative-time renders (`elapsedSince`, `relativeTime`)
 * read it alongside their timestamp so they re-render as time passes;
 * without it they computed once at mount and froze ("created just now"
 * forever). One interval for the whole app: N stamps on screen must not
 * mean N timers.
 */

import { createSignal } from "solid-js";

export const CLOCK_TICK_MS = 30_000;

const [tick, setTick] = createSignal(Date.now());

/**
 * Current wall-clock time, refreshed every {@link CLOCK_TICK_MS}. Pass it
 * as the `now` argument of a formatter to make that render time-reactive:
 *
 *   `relativeTime(s.createdAt, nowTick())`
 */
export const nowTick = tick;

const interval = setInterval(() => setTick(Date.now()), CLOCK_TICK_MS);
// Node-flavoured timers (vitest without jsdom, SSR) must not hold the
// process open for a display-refresh interval.
if (typeof interval === "object" && interval !== null && "unref" in interval) {
  (interval as unknown as { unref: () => void }).unref();
}
