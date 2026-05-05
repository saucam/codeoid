/**
 * Persistent layout state — sidebar widths + collapse flags. Pure UX,
 * stored in localStorage so reloads keep the user's preferred chrome.
 *
 * No daemon dependency: this is the only file outside drafts/auth that
 * persists client-side, intentionally.
 */

import { batch, createEffect, createSignal } from "solid-js";

const STORAGE_KEY = "codeoid.layout.v1";

interface LayoutState {
  leftSidebarPx: number;
  leftSidebarCollapsed: boolean;
  rightPanePx: number;
}

const DEFAULTS: LayoutState = {
  leftSidebarPx: 280,
  leftSidebarCollapsed: false,
  rightPanePx: 576, // 36rem-ish
};

const LIMITS = {
  leftMinPx: 200,
  leftMaxPx: 600,
  leftCollapsedPx: 56,
  rightMinPx: 280,
  rightMaxPx: 1200,
};

function load(): LayoutState {
  if (typeof localStorage === "undefined") return DEFAULTS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      leftSidebarPx:
        typeof parsed.leftSidebarPx === "number"
          ? clamp(parsed.leftSidebarPx, LIMITS.leftMinPx, LIMITS.leftMaxPx)
          : DEFAULTS.leftSidebarPx,
      leftSidebarCollapsed:
        typeof parsed.leftSidebarCollapsed === "boolean"
          ? parsed.leftSidebarCollapsed
          : DEFAULTS.leftSidebarCollapsed,
      rightPanePx:
        typeof parsed.rightPanePx === "number"
          ? clamp(parsed.rightPanePx, LIMITS.rightMinPx, LIMITS.rightMaxPx)
          : DEFAULTS.rightPanePx,
    };
  } catch {
    return DEFAULTS;
  }
}

const initial = load();

const [leftSidebarPx, setLeftSidebarPx] = createSignal(initial.leftSidebarPx);
const [leftSidebarCollapsed, setLeftSidebarCollapsed] = createSignal(
  initial.leftSidebarCollapsed,
);
const [rightPanePx, setRightPanePx] = createSignal(initial.rightPanePx);

/** Effective width for the left sidebar accounting for collapse. */
export function leftSidebarEffectivePx(): number {
  return leftSidebarCollapsed() ? LIMITS.leftCollapsedPx : leftSidebarPx();
}

export const sidebarWidth = leftSidebarPx;
export const isLeftCollapsed = leftSidebarCollapsed;
export const rightWidth = rightPanePx;

export function setLeftWidth(px: number): void {
  setLeftSidebarPx(clamp(px, LIMITS.leftMinPx, LIMITS.leftMaxPx));
}

export function setRightWidth(px: number): void {
  setRightPanePx(clamp(px, LIMITS.rightMinPx, LIMITS.rightMaxPx));
}

export function toggleLeftCollapsed(): void {
  setLeftSidebarCollapsed((v) => !v);
}

export function setLeftCollapsed(v: boolean): void {
  setLeftSidebarCollapsed(v);
}

// Persist on every change. Single effect — no per-setter writes.
createEffect(() => {
  const snapshot: LayoutState = {
    leftSidebarPx: leftSidebarPx(),
    leftSidebarCollapsed: leftSidebarCollapsed(),
    rightPanePx: rightPanePx(),
  };
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota / private mode — drop silently.
  }
});

export const LIMITS_RO = LIMITS;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function _resetLayoutForTest(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  batch(() => {
    setLeftSidebarPx(DEFAULTS.leftSidebarPx);
    setLeftSidebarCollapsed(DEFAULTS.leftSidebarCollapsed);
    setRightPanePx(DEFAULTS.rightPanePx);
  });
}
