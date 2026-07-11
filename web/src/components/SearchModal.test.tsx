// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown) => Promise<unknown>>(() => Promise.resolve({ sessions: [] })),
);
vi.mock("../state/connection", () => ({
  getClient: () => ({ request: requestMock }),
  newRequestId: () => "r",
}));

import SearchModal from "./SearchModal";
import { _resetSessionsForTest } from "../state/sessions";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  requestMock.mockReset();
  requestMock.mockImplementation(() => Promise.resolve({ sessions: [] }));
  vi.useRealTimers();
});

function openModal() {
  const r = render(() => <SearchModal />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const input = r.container.querySelector("input") as HTMLInputElement;
  expect(input).toBeTruthy();
  return { ...r, input };
}

describe("SearchModal stale in-flight results", () => {
  it("drops results that resolve after the query shrank below 2 chars", async () => {
    // A slow search we can resolve on demand.
    let resolveSearch!: (v: unknown) => void;
    requestMock.mockImplementationOnce(
      () => new Promise((res) => (resolveSearch = res)),
    );

    const { input, queryByText } = openModal();

    // Type a real query and let the debounce fire → request in flight.
    fireEvent.input(input, { target: { value: "shield" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(requestMock).toHaveBeenCalledTimes(1);

    // Shrink below the 2-char threshold BEFORE the response lands.
    fireEvent.input(input, { target: { value: "s" } });

    // Now the stale response arrives.
    resolveSearch({
      sessions: [
        {
          sessionId: "sess-x",
          sessionName: "stale-hit-session",
          matchCount: 3,
          lastMatchAt: 1,
          snippets: [],
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(10);

    // The old bug: the short-query branch cleared hits but never bumped
    // runId, so the in-flight response repopulated the list under the
    // "type at least 2 characters" hint.
    expect(queryByText(/stale-hit-session/)).toBeNull();
  });

  it("clears a lingering error when the query shrinks", async () => {
    requestMock.mockImplementationOnce(() => Promise.reject(new Error("search exploded")));

    const { input, queryByText, findByText } = openModal();

    fireEvent.input(input, { target: { value: "shield" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(await findByText(/search exploded/)).toBeTruthy();

    fireEvent.input(input, { target: { value: "s" } });
    await vi.advanceTimersByTimeAsync(10);
    expect(queryByText(/search exploded/)).toBeNull();
  });
});
