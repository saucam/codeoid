// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

// Avoid loading real shiki (WASM) in tests — highlighting is orthogonal to the
// row-capping behaviour under test.
vi.mock("../../lib/shiki", () => ({
  ensureLang: async () => ({ getLoadedLanguages: () => [], codeToHtml: () => "" }),
  langForFilename: () => "text",
}));

import { WriteFile } from "./EditDiff";

afterEach(cleanup);

/** Count rendered code rows via their line-number gutter (`.w-10`), which the
 *  truncation footer doesn't have. */
function rowCount(container: HTMLElement): number {
  return container.querySelectorAll(".w-10").length;
}

describe("WriteFile preview cap", () => {
  it("caps a large write at 400 rendered lines with a truncation footer", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const { container } = render(() => (
      <WriteFile input={{ file_path: "big.ts", content }} />
    ));
    expect(rowCount(container)).toBe(400); // NOT 500
    expect(container.textContent).toContain("100 more lines");
    expect(container.textContent).toContain("500 lines"); // header shows the true total
  });

  it("renders every line and no footer for a small write", () => {
    const { container } = render(() => (
      <WriteFile input={{ file_path: "x.ts", content: "a\nb\nc" }} />
    ));
    expect(rowCount(container)).toBe(3);
    expect(container.textContent).not.toContain("more line");
  });
});
