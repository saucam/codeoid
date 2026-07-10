// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import MessageRow from "./MessageRow";
import type { SessionMessage } from "../../protocol/types";

function thinkingMsg(content: string): SessionMessage {
  return {
    type: "session.message",
    sessionId: "s",
    messageId: "m1",
    role: "thinking",
    content,
    identity: { sub: "x", name: "a", type: "agent" },
    timestamp: "2026-05-04T08:00:00Z",
  } as unknown as SessionMessage;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThinkingBlock", () => {
  it("shows a correct line count", () => {
    const three = render(() => <MessageRow msg={thinkingMsg("a\nb\nc")} />);
    expect(three.container.textContent).toContain("reasoning (3 lines)");
    cleanup();
    const one = render(() => <MessageRow msg={thinkingMsg("no newline here")} />);
    expect(one.container.textContent).toContain("reasoning (1 lines)");
  });

  it("coalesces streaming deltas to one recount per animation frame", () => {
    // Manual rAF queue so the flush moment is deterministic (same pattern
    // as streaming-markdown.test.ts, which MarkdownBlock's throttle uses).
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const [msg, setMsg] = createSignal(thinkingMsg("a\nb"));
    const { container } = render(() => <MessageRow msg={msg()} streaming={true} />);
    expect(container.textContent).toContain("reasoning (2 lines)");

    // Two rapid deltas: held until the frame fires, and only ONE frame
    // scheduled — the whole-text re-split per delta is gone.
    setMsg(thinkingMsg("a\nb\nc"));
    setMsg(thinkingMsg("a\nb\nc\nd"));
    expect(container.textContent).toContain("reasoning (2 lines)");
    expect(queue.length).toBe(1);

    // The flush delivers the LATEST text and count.
    queue.shift()!(0);
    expect(container.textContent).toContain("reasoning (4 lines)");
    expect(container.textContent).toContain("a\nb\nc\nd");
  });

  it("updates synchronously when not streaming (throttle passthrough)", () => {
    const [msg, setMsg] = createSignal(thinkingMsg("x"));
    const { container } = render(() => <MessageRow msg={msg()} />);
    expect(container.textContent).toContain("reasoning (1 lines)");
    setMsg(thinkingMsg("x\ny\nz"));
    expect(container.textContent).toContain("reasoning (3 lines)");
    expect(container.textContent).toContain("x\ny\nz");
  });
});
