// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";

// The Esc-to-interrupt guard in App.tsx defers to an open modal/drawer by
// looking for its overlay root. This asserts the FIX: the selector must match a
// modal overlay but NOT the always-present sticky Sessions/Files headers (the
// old `[class*="backdrop-blur"]` matched those, making Esc-interrupt dead).
afterEach(() => {
  document.body.innerHTML = "";
});

describe("Esc-interrupt overlay guard selector", () => {
  it("`.fixed.inset-0` ignores sticky headers but matches a modal overlay", () => {
    // The two sticky chrome headers (SessionListPane / FileTree) use bare
    // `sticky … backdrop-blur`.
    document.body.innerHTML = `
      <div class="sticky top-0 z-10 backdrop-blur">Sessions</div>
      <div class="sticky top-0 backdrop-blur">Files</div>
    `;
    // No modal open → the fixed guard must not match (so Esc interrupts).
    expect(document.querySelector(".fixed.inset-0")).toBeNull();
    // …whereas the OLD selector wrongly matched the headers (the bug).
    expect(document.querySelector('[class*="backdrop-blur"]')).not.toBeNull();

    // Modals/drawers use `fixed inset-0 … backdrop-blur-sm`.
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"></div>',
    );
    expect(document.querySelector(".fixed.inset-0")).not.toBeNull();
  });
});
