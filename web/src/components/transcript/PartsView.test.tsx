// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock("../../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));

import PartsView, { hasRichParts } from "./PartsView";
import type { ContentPart } from "../../protocol/types";

afterEach(() => {
  cleanup();
  requestMock.mockClear();
});

function draw(parts: ContentPart[]) {
  return render(() => <PartsView parts={parts} sessionId="s" messageId="m" />);
}

describe("hasRichParts", () => {
  it("is false for absent/empty/single-text parts (legacy path)", () => {
    expect(hasRichParts(undefined)).toBe(false);
    expect(hasRichParts([])).toBe(false);
    expect(hasRichParts([{ kind: "text", text: "hi" }])).toBe(false);
  });

  it("is true for any non-text or multi-part payload", () => {
    expect(hasRichParts([{ kind: "table", headers: ["a"], rows: [["1"]] }])).toBe(true);
    expect(
      hasRichParts([
        { kind: "text", text: "hi" },
        { kind: "diff", path: "a.ts", added: 1, removed: 2 },
      ]),
    ).toBe(true);
  });
});

describe("PartsView", () => {
  it("renders code, diff, table, progress, and anchor parts", () => {
    const { getByText, container } = draw([
      { kind: "code", code: "const x = 1;", language: "ts", filePath: "src/x.ts" },
      { kind: "diff", path: "src/y.ts", added: 3, removed: 1 },
      { kind: "table", headers: ["name"], rows: [["pi"]] },
      { kind: "progress", message: "indexing", percent: 40 },
      { kind: "anchor", uri: "https://example.com", title: "docs" },
    ]);
    expect(getByText("const x = 1;")).toBeTruthy();
    expect(getByText("src/x.ts")).toBeTruthy();
    expect(getByText("+3")).toBeTruthy();
    expect(getByText("−1")).toBeTruthy();
    expect(getByText("pi")).toBeTruthy();
    expect(getByText("indexing")).toBeTruthy();
    const link = getByText("docs") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com");
    expect(link.getAttribute("rel")).toContain("noopener");
    // Unsafe schemes never render as links (sanitizer returns "").
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });

  it("drops javascript: anchors to plain text", () => {
    const { getByText, container } = draw([
      { kind: "anchor", uri: "javascript:alert(1)", title: "evil" },
    ]);
    expect(getByText("evil")).toBeTruthy();
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("buttons dispatch session.part_action with action + data", async () => {
    const { getByText } = draw([
      {
        kind: "button",
        label: "Deploy",
        action: "deploy",
        data: { env: "dev" },
        style: "primary",
      },
    ]);
    fireEvent.click(getByText("Deploy"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session.part_action",
          sessionId: "s",
          messageId: "m",
          action: "deploy",
          data: { env: "dev" },
        }),
      ),
    );
  });

  it("shows the daemon's rejection next to the button", async () => {
    requestMock.mockImplementationOnce(() => Promise.reject(new Error("no handler")));
    const { getByText, findByText } = draw([
      { kind: "button", label: "Retry", action: "retry" },
    ]);
    fireEvent.click(getByText("Retry"));
    expect(await findByText("no handler")).toBeTruthy();
  });
});
