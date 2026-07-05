/**
 * UTC day-bucket helpers for the analytics panel.
 *
 * The daemon buckets usage by SQLite `date(created_at/1000, 'unixepoch')`,
 * which is UTC. The client must derive its bucket keys and "today" in UTC
 * too — the previous implementation stepped days with local-time
 * `setDate()/getDate()` and then read the key via `toISOString()` (UTC),
 * which mismatches daemon buckets for any user not on UTC and can
 * skip/duplicate a day around DST transitions.
 */

export interface DayCostBucket {
  day: string;
  costUsd: number;
}

const DAY_MS = 86_400_000; // UTC days have no DST; fixed stepping is exact.

/** `YYYY-MM-DD` in UTC for an epoch-ms timestamp. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Expand sparse daemon buckets into a dense `days`-long window ending at
 * the UTC day containing `nowMs`, filling gaps with zero cost.
 */
export function padDays(
  data: ReadonlyArray<{ day: string; costUsd: number }>,
  days: number,
  nowMs: number = Date.now(),
): DayCostBucket[] {
  const map = new Map(data.map((d) => [d.day, d.costUsd]));
  const result: DayCostBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = utcDayKey(nowMs - i * DAY_MS);
    result.push({ day: key, costUsd: map.get(key) ?? 0 });
  }
  return result;
}
