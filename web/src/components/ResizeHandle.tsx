/**
 * Generic vertical-divider drag handle. Pointer-event based so it works
 * on touch + pen as well as mouse. Caller passes `onResize(px)` and
 * decides what to do with the new width.
 *
 * Visual: a 4px gutter that highlights on hover and during drag. Cursor
 * changes to ew-resize. Double-click resets to whatever the caller
 * provides via `onReset`.
 */

import { Component, onCleanup, onMount } from "solid-js";

const ResizeHandle: Component<{
  /** Direction the handle is on relative to the resizable pane. */
  side: "left" | "right";
  /** Current width in px (used to compute deltas during drag). */
  current: () => number;
  /** Called with the new width on every move. */
  onResize: (px: number) => void;
  /** Optional double-click reset value. */
  onReset?: () => void;
  ariaLabel?: string;
}> = (props) => {
  let el: HTMLDivElement | undefined;
  let startX = 0;
  let startW = 0;
  let dragging = false;

  function onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    dragging = true;
    startX = ev.clientX;
    startW = props.current();
    el?.setPointerCapture(ev.pointerId);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    el?.classList.add("is-dragging");
  }

  function onPointerMove(ev: PointerEvent): void {
    if (!dragging) return;
    const delta = ev.clientX - startX;
    const next = props.side === "right"
      ? startW + delta // dragging right edge of left pane
      : startW - delta; // dragging left edge of right pane
    props.onResize(next);
  }

  function onPointerUp(ev: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    el?.releasePointerCapture(ev.pointerId);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    el?.classList.remove("is-dragging");
  }

  onMount(() => {
    if (!el) return;
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    onCleanup(() => {
      if (!el) return;
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    });
  });

  return (
    <div
      ref={el}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.ariaLabel ?? "Resize"}
      tabIndex={0}
      onDblClick={() => props.onReset?.()}
      class="group relative cursor-ew-resize touch-none select-none"
      style={{ width: "4px" }}
    >
      <div class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent/60 [.is-dragging_&]:bg-accent" />
    </div>
  );
};

export default ResizeHandle;
