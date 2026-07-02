import { For, Show, onMount } from "solid-js";
import { analyticsLoading, dailyUsage, fetchAnalytics, lifetimeTotals } from "../state/analytics";
import { formatCostUsd, formatTokens } from "../lib/format";
import { padDays, utcDayKey } from "../lib/usage-days";

const DAYS = 14;
const BAR_W = 14;
const BAR_GAP = 6;
const CHART_H = 48;
const LABEL_H = 14;
const CHART_W = DAYS * (BAR_W + BAR_GAP) - BAR_GAP;

const AnalyticsPanel = () => {
  onMount(() => { void fetchAnalytics(DAYS); });

  const padded = () => padDays(dailyUsage(), DAYS);
  const maxCost = () => Math.max(...padded().map((d) => d.costUsd), 0.001);
  // UTC to match the daemon's sqlite date() bucketing — see lib/usage-days.
  const today = utcDayKey(Date.now());

  return (
    <div class="px-3 pb-3 pt-1 border-b border-border">
      <Show when={lifetimeTotals()}>
        {(lt) => (
          <div class="mb-2 grid grid-cols-3 gap-1 text-center">
            <div class="rounded bg-bg px-1 py-1.5">
              <div class="font-mono text-[12px] font-medium text-accent">{formatCostUsd(lt().costUsd)}</div>
              <div class="text-[9px] uppercase tracking-wide text-fg-faint">all time</div>
            </div>
            <div class="rounded bg-bg px-1 py-1.5">
              <div class="font-mono text-[12px] font-medium text-fg">{lt().numTurns.toLocaleString()}</div>
              <div class="text-[9px] uppercase tracking-wide text-fg-faint">turns</div>
            </div>
            <div class="rounded bg-bg px-1 py-1.5">
              <div class="font-mono text-[12px] font-medium text-fg">{formatTokens(lt().inputTokens + lt().outputTokens)}</div>
              <div class="text-[9px] uppercase tracking-wide text-fg-faint">tokens</div>
            </div>
          </div>
        )}
      </Show>

      <div class="mb-1 text-[9px] uppercase tracking-wide text-fg-faint">last 14 days</div>

      <Show when={analyticsLoading() && dailyUsage().length === 0}>
        <div class="text-[11px] text-fg-faint">loading…</div>
      </Show>
      <Show when={!analyticsLoading() || dailyUsage().length > 0}>
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H + LABEL_H}`}
          width="100%"
          aria-label="14-day cost chart"
        >
          <For each={padded()}>
            {(bucket, i) => {
              const barH = () =>
                bucket.costUsd > 0
                  ? Math.max(2, (bucket.costUsd / maxCost()) * CHART_H)
                  : 0;
              const x = () => i() * (BAR_W + BAR_GAP);
              const isToday = () => bucket.day === today;
              const dayLabel = () => {
                const d = new Date(bucket.day + "T00:00:00Z");
                return d
                  .toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })
                  .slice(0, 1);
              };
              return (
                <>
                  <title>{`${bucket.day}: ${formatCostUsd(bucket.costUsd)}`}</title>
                  <rect
                    x={x()}
                    y={CHART_H - barH()}
                    width={BAR_W}
                    height={barH()}
                    rx="2"
                    style={
                      isToday()
                        ? "fill: var(--color-accent)"
                        : "fill: var(--color-accent); opacity: 0.45"
                    }
                  />
                  <text
                    x={x() + BAR_W / 2}
                    y={CHART_H + LABEL_H - 2}
                    text-anchor="middle"
                    style="fill: var(--color-fg-faint)"
                    font-size="8"
                  >
                    {dayLabel()}
                  </text>
                </>
              );
            }}
          </For>
        </svg>
      </Show>
    </div>
  );
};

export default AnalyticsPanel;
