import { createSignal } from "solid-js";
import type { DailyUsageBucket, LifetimeUsageTotals } from "../protocol/types";
import { getClient } from "./connection";

const [daily, setDaily] = createSignal<DailyUsageBucket[]>([]);
const [lifetime, setLifetime] = createSignal<LifetimeUsageTotals | null>(null);
const [loading, setLoading] = createSignal(false);

export const dailyUsage = daily;
export const lifetimeTotals = lifetime;
export const analyticsLoading = loading;

export async function fetchAnalytics(days = 14): Promise<void> {
  if (loading()) return;
  setLoading(true);
  try {
    const c = getClient();
    const id = c.nextId();
    const result = await c.request<{ type: "response.ok"; requestId: string; data: { daily: DailyUsageBucket[]; lifetime: LifetimeUsageTotals } }>(
      { id, type: "usage.daily", days },
    );
    if (result.data) {
      setDaily(result.data.daily);
      setLifetime(result.data.lifetime);
    }
  } catch (err) {
    // Panel stays empty (no crash), but never silently: a permanently
    // blank analytics panel with zero console output made daemon-side
    // failures (e.g. the old SQLite bound-variable overflow at ~1000
    // sessions) undiagnosable.
    console.error("[codeoid] usage.daily request failed:", err);
  } finally {
    setLoading(false);
  }
}
