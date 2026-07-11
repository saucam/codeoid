// @vitest-environment jsdom
/**
 * Transcript attach-lifecycle UX + older-history backfill (#152).
 *
 * The empty-state used to key purely on `messages().length === 0`, showing a
 * confident "No messages yet" while a replay was in flight — and forever
 * after a failed attach. These tests drive the REAL attach/messages/sessions
 * stores (only the connection transport is mocked) and assert:
 *
 *   - "loading transcript…" while attach is pending (never the empty-state)
 *   - the true empty-state only when settled AND empty
 *   - attach failure surfaced with a Retry affordance
 *   - the older-history sentinel: visibility, click-to-load with the right
 *     anchor, in-order deduped prepend, hasMore=false hiding it, and
 *     error → retry
 *   - computeAnchoredScrollTop arithmetic (jsdom has no real layout, so the
 *     scroll-anchoring helper is what gets unit-tested)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

// jsdom lacks ResizeObserver; the virtualizer and the sticky-bottom pin both
// construct one at mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// jsdom 29 SHIPS an IntersectionObserver whose callback fires on observe()
// (no layout, everything "intersects") — that would auto-trigger the
// sentinel's backfill at mount and consume the one-shot request mocks the
// click tests set up. Replace it with a controllable stub: inert by
// default, and the auto-trigger test fires it by hand.
class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  observed: Element[] = [];
  constructor(
    public callback: (
      entries: Array<{ isIntersecting: boolean; target: Element }>,
      observer: IntersectionObserverStub,
    ) => void,
  ) {
    IntersectionObserverStub.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(el: Element): void {
    this.observed = this.observed.filter((o) => o !== el);
  }
  disconnect(): void {
    this.observed = [];
  }
}
vi.stubGlobal("IntersectionObserver", IntersectionObserverStub);

// The transport — attach.ts reaches it via dynamic import("./connection"),
// which vi.mock intercepts by resolved path.
const clientRequestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown, opts?: unknown) => Promise<unknown>>(() =>
    Promise.resolve({}),
  ),
);
vi.mock("../../state/connection", () => ({
  request: vi.fn(() => Promise.resolve({})),
  newRequestId: () => "req-1",
  getClient: () => ({ request: clientRequestMock }),
}));

import Transcript, { computeAnchoredScrollTop } from "./Transcript";
import {
  _resetAttachForTest,
  attachRetryEpoch,
  attachState,
  markAttachFailed,
  markAttachPending,
  markAttachSettled,
  noteAttachReplay,
} from "../../state/attach";
import {
  _resetMessagesForTest,
  messagesFor,
  replaceScrollback,
} from "../../state/messages";
import { _resetSessionsForTest, focusSession, mergeSession } from "../../state/sessions";
import type { ScrollbackReplayMsg, SessionMessage } from "../../protocol/types";

const SID = "sess-1";

function makeMsg(messageId: string, content = `body ${messageId}`): SessionMessage {
  return {
    type: "session.message",
    sessionId: SID,
    messageId,
    role: "assistant",
    content,
    identity: { sub: "agent:a", type: "agent" as const },
    timestamp: "2026-07-11T00:00:00Z",
  } as SessionMessage;
}

function tailReplay(hasMore: boolean): ScrollbackReplayMsg {
  return {
    type: "scrollback.replay",
    sessionId: SID,
    messages: [],
    tail: true,
    hasMore,
  } as ScrollbackReplayMsg;
}

function focusSessionWithRecord(): void {
  mergeSession({ id: SID, name: "t", status: "idle" });
  focusSession(SID);
}

function pageResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "scrollback.page.result",
    requestId: "req-1",
    sessionId: SID,
    messages: [],
    hasMore: false,
    source: "buffer",
    ...overrides,
  };
}

beforeEach(() => {
  focusSessionWithRecord();
});

afterEach(() => {
  cleanup();
  _resetAttachForTest();
  _resetMessagesForTest();
  _resetSessionsForTest();
  IntersectionObserverStub.instances = [];
  clientRequestMock.mockReset();
  clientRequestMock.mockImplementation(() => Promise.resolve({}));
});

describe("empty-state vs attach lifecycle", () => {
  it("shows 'loading transcript…' while attach is pending — NOT the empty-state", () => {
    markAttachPending(SID);
    const { queryByText } = render(() => <Transcript />);
    expect(queryByText(/loading transcript…/)).toBeTruthy();
    expect(queryByText(/No messages yet/)).toBeNull();
  });

  it("shows the real empty-state only when settled AND empty", () => {
    markAttachSettled(SID);
    const { queryByText } = render(() => <Transcript />);
    expect(queryByText(/No messages yet — type below and press Enter\./)).toBeTruthy();
    expect(queryByText(/loading transcript…/)).toBeNull();
  });

  it("flips pending → loading fallback reactively when the replay settles", async () => {
    markAttachPending(SID);
    const { queryByText, findByText } = render(() => <Transcript />);
    expect(queryByText(/loading transcript…/)).toBeTruthy();
    noteAttachReplay(tailReplay(false)); // first replay frame arrives
    expect(await findByText(/No messages yet/)).toBeTruthy();
  });

  it("shows the attach error with a Retry affordance on failure", () => {
    markAttachFailed(SID, "Missing scope: session:attach");
    const { queryByText, getByText } = render(() => <Transcript />);
    expect(queryByText(/Couldn't attach to this session/)).toBeTruthy();
    expect(queryByText(/Missing scope: session:attach/)).toBeTruthy();
    expect(queryByText(/No messages yet/)).toBeNull();

    const before = attachRetryEpoch();
    fireEvent.click(getByText("Retry"));
    // Retry resets the phase and bumps the epoch App.tsx's attach effect
    // tracks — the re-dispatch itself is App's job.
    expect(attachState(SID)).toBe("idle");
    expect(attachRetryEpoch()).toBe(before + 1);
  });

  it("surfaces a re-attach failure as a banner when messages already exist", () => {
    replaceScrollback(SID, [makeMsg("m1")]);
    markAttachFailed(SID, "socket dropped");
    const { queryByText } = render(() => <Transcript />);
    expect(queryByText(/Attach failed/)).toBeTruthy();
    expect(queryByText(/socket dropped/)).toBeTruthy();
    // The transcript itself still renders (not the empty-state fallback).
    expect(queryByText(/No messages yet/)).toBeNull();
  });
});

describe("older-history sentinel + backfill", () => {
  function seed(hasMore = true): void {
    replaceScrollback(SID, [makeMsg("m4"), makeMsg("m5")]);
    noteAttachReplay(tailReplay(hasMore));
  }

  it("renders the sentinel only when older history exists", () => {
    seed(false);
    const { queryByTestId } = render(() => <Transcript />);
    expect(queryByTestId("older-history-sentinel")).toBeNull();
  });

  it("click loads a page anchored on the oldest held id, prepends in order, dedupes", async () => {
    seed(true);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(
        pageResult({
          // m4 overlaps what we already hold — must be deduped, not doubled.
          messages: [makeMsg("m2"), makeMsg("m3"), makeMsg("m4")],
          hasMore: true,
        }),
      ),
    );

    const { getByText, queryByTestId } = render(() => <Transcript />);
    fireEvent.click(getByText(/older messages — scroll or click to load/));

    await waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(1));
    expect(clientRequestMock.mock.calls[0]![0]).toMatchObject({
      type: "scrollback.page",
      sessionId: SID,
      beforeMessageId: "m4",
    });
    await waitFor(() =>
      expect(messagesFor(SID).map((m) => m.messageId)).toEqual([
        "m2",
        "m3",
        "m4",
        "m5",
      ]),
    );
    // hasMore=true → the sentinel stays for the next page.
    expect(queryByTestId("older-history-sentinel")).toBeTruthy();
  });

  it("hasMore=false hides the sentinel after the page lands", async () => {
    seed(true);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(pageResult({ messages: [makeMsg("m3")], hasMore: false })),
    );
    const { getByText, queryByTestId } = render(() => <Transcript />);
    expect(queryByTestId("older-history-sentinel")).toBeTruthy();
    fireEvent.click(getByText(/older messages — scroll or click to load/));
    await waitFor(() => expect(queryByTestId("older-history-sentinel")).toBeNull());
    expect(messagesFor(SID).map((m) => m.messageId)).toEqual(["m3", "m4", "m5"]);
  });

  it("shows 'loading older…' while the page request is in flight", async () => {
    seed(true);
    let resolvePage!: (v: unknown) => void;
    clientRequestMock.mockImplementationOnce(
      () => new Promise((res) => (resolvePage = res)),
    );
    const { getByText, findByText, queryByText } = render(() => <Transcript />);
    fireEvent.click(getByText(/older messages — scroll or click to load/));
    expect(await findByText(/loading older…/)).toBeTruthy();
    // Wait for the (async) transport dispatch before resolving it.
    await waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(1));
    resolvePage(pageResult({ messages: [makeMsg("m3")], hasMore: true }));
    await waitFor(() => expect(queryByText(/loading older…/)).toBeNull());
    expect(queryByText(/older messages — scroll or click to load/)).toBeTruthy();
  });

  it("auto-triggers the backfill when the sentinel scrolls into view", async () => {
    seed(true);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(pageResult({ messages: [makeMsg("m3")], hasMore: false })),
    );
    const { getByTestId } = render(() => <Transcript />);
    const sentinel = getByTestId("older-history-sentinel");

    // The component wired the sentinel into its IntersectionObserver…
    const io = IntersectionObserverStub.instances.find((i) =>
      i.observed.includes(sentinel),
    );
    expect(io).toBeTruthy();

    // …and an intersection fires the same load path as a click.
    io!.callback([{ isIntersecting: false, target: sentinel }], io!);
    expect(clientRequestMock).not.toHaveBeenCalled(); // out of view — no-op
    io!.callback([{ isIntersecting: true, target: sentinel }], io!);
    await waitFor(() => expect(clientRequestMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(messagesFor(SID).map((m) => m.messageId)).toEqual(["m3", "m4", "m5"]),
    );
  });

  it("surfaces a paging error with a working Retry", async () => {
    seed(true);
    clientRequestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("page blew up")),
    );
    const { getByText, findByText, queryByText } = render(() => <Transcript />);
    fireEvent.click(getByText(/older messages — scroll or click to load/));
    expect(await findByText(/page blew up/)).toBeTruthy();

    clientRequestMock.mockImplementationOnce(() =>
      Promise.resolve(pageResult({ messages: [makeMsg("m3")], hasMore: false })),
    );
    fireEvent.click(getByText("Retry"));
    // The error clears synchronously (new attempt), the page lands async.
    expect(queryByText(/page blew up/)).toBeNull();
    await waitFor(() =>
      expect(messagesFor(SID).map((m) => m.messageId)).toEqual(["m3", "m4", "m5"]),
    );
  });
});

describe("computeAnchoredScrollTop", () => {
  it("preserves the distance from scroll position to the content bottom", () => {
    // 1000px of content, viewport parked 600px down → 400px below the fold.
    // Prepending 500px grows the content to 1500px; the same view is at 1100.
    expect(computeAnchoredScrollTop(1000, 600, 1500)).toBe(1100);
  });

  it("is identity when nothing was actually prepended", () => {
    expect(computeAnchoredScrollTop(1000, 600, 1000)).toBe(600);
  });

  it("anchors a top-parked viewport to the start of the old content", () => {
    // scrollTop 0 before the prepend → exactly the prepended extent after.
    expect(computeAnchoredScrollTop(800, 0, 1300)).toBe(500);
  });
});
