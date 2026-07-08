import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createFrameThrottled, splitStreamingBlocks } from "./streaming-markdown";

describe("splitStreamingBlocks", () => {
  it("splits completed paragraphs off and keeps the last segment as tail", () => {
    const { blocks, tail } = splitStreamingBlocks("para one\n\npara two\n\npara thr");
    expect(blocks).toEqual(["para one\n", "para two\n"]);
    expect(tail).toBe("para thr");
  });

  it("reassembles to the original text (modulo dropped blank separators)", () => {
    const text = "# Title\n\nBody text.\n\n- item 1\n- item 2\n\ntrailing";
    const { blocks, tail } = splitStreamingBlocks(text);
    const joined = [...blocks, tail].join("\n");
    // Every non-blank line survives, in order.
    expect(joined.split("\n").filter((l) => l.trim())).toEqual(
      text.split("\n").filter((l) => l.trim()),
    );
  });

  it("never splits inside a fenced code block", () => {
    const text = "intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter\n\ntail";
    const { blocks, tail } = splitStreamingBlocks(text);
    // The fence (with its interior blank line) stays in ONE segment.
    const fenceSegment = [...blocks, tail].find((s) => s.includes("```ts"));
    expect(fenceSegment).toContain("const a = 1;");
    expect(fenceSegment).toContain("const b = 2;");
    expect(tail).toBe("tail");
  });

  it("treats an unclosed streaming fence as part of the tail", () => {
    const { blocks, tail } = splitStreamingBlocks("done para\n\n```bash\necho hi\n\necho aga");
    expect(blocks).toEqual(["done para\n"]);
    expect(tail).toContain("echo aga");
    expect(tail).toContain("```bash");
  });

  it("flags an open fence in the tail so callers can plain-render it", () => {
    expect(
      splitStreamingBlocks("intro\n\n```ts\nconst x = 1\nconst y =").tailOpenFence,
    ).toBe(true);
    // Closed fence or a plain paragraph tail is not flagged.
    expect(splitStreamingBlocks("```ts\nx\n```\n\nafter").tailOpenFence).toBe(false);
    expect(splitStreamingBlocks("just a paragraph tail").tailOpenFence).toBe(false);
  });

  it("handles ~~~ fences and leading indentation", () => {
    const { tail } = splitStreamingBlocks("  ~~~\nraw\n\nstill raw\n");
    expect(tail).toContain("still raw");
  });

  it("only closes a fence on a matching closer (same char, >= length, no trailing text)", () => {
    // A literal ```-prefixed line inside a ~~~ fence is content, not a closer.
    const mixed = splitStreamingBlocks("~~~\n``` not a closer\n\nstill fenced\n~~~\n\nout");
    expect(mixed.blocks[0]).toContain("still fenced");
    expect(mixed.tail).toBe("out");

    // A fence-like line with trailing text can't close either (info strings
    // are opener-only in CommonMark).
    const trailing = splitStreamingBlocks("```\n```not a closer\n\nstill fenced\n```\n\nout");
    expect(trailing.blocks[0]).toContain("still fenced");
    expect(trailing.tail).toBe("out");

    // A shorter marker run can't close a longer opener; an equal/longer one can.
    const shorter = splitStreamingBlocks("````\n```\n\nstill fenced\n````\n\nout");
    expect(shorter.blocks[0]).toContain("still fenced");
    expect(shorter.tail).toBe("out");
  });

  it("returns everything as tail when there is no boundary", () => {
    const { blocks, tail } = splitStreamingBlocks("single para, still streaming");
    expect(blocks).toEqual([]);
    expect(tail).toBe("single para, still streaming");
  });

  it("handles empty input", () => {
    expect(splitStreamingBlocks("")).toEqual({ blocks: [], tail: "", tailOpenFence: false });
  });
});

describe("createFrameThrottled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes updates straight through when inactive, coalesces to one rAF flush when active", () => {
    // Manual rAF queue so the flush moment is deterministic.
    const queue: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    // Create inside a root, assert OUTSIDE it — writes made within the root
    // body are batched until the body completes, so effects wouldn't re-run
    // between assertions there.
    const h = createRoot((dispose) => {
      const [text, setText] = createSignal("a");
      const [active, setActive] = createSignal(false);
      const throttled = createFrameThrottled(text, active);
      return { throttled, setText, setActive, dispose };
    });

    // Inactive → synchronous passthrough.
    h.setText("ab");
    expect(h.throttled()).toBe("ab");

    // Active → updates are held until the frame fires…
    h.setActive(true);
    h.setText("abc");
    h.setText("abcd");
    expect(h.throttled()).toBe("ab");
    expect(queue.length).toBe(1); // …and only ONE frame was scheduled.

    // Frame flush delivers the LATEST value.
    queue.shift()!(0);
    expect(h.throttled()).toBe("abcd");

    // Deactivating flushes immediately again.
    h.setText("abcde");
    h.setActive(false);
    expect(h.throttled()).toBe("abcde");

    h.dispose();
  });
});
