/**
 * Message → ANSI renderer. Exercises every role, the session banner,
 * attachment rendering, and the "no color when piped" path.
 *
 * We run these with FORCE_COLOR=1 so the renderer emits SGR bytes we
 * can assert against. A separate block flips FORCE_COLOR off and
 * checks that no escapes leak through.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type {
  MessageIdentity,
  SessionMessage,
} from "../protocol/types.js";
import {
  renderMessage,
  renderSessionBanner,
} from "../tui/ansi/render-message.js";
import { stripAnsi } from "../tui/ansi/codes.js";

const ESC = "\x1b";

const USER: MessageIdentity = { sub: "user:test", name: "alice", type: "human" };
const AGENT: MessageIdentity = {
  sub: "agent:a",
  name: "claude",
  type: "agent",
};

function baseMsg(
  partial: Partial<SessionMessage> & Pick<SessionMessage, "role">,
): SessionMessage {
  return {
    type: "session.message",
    sessionId: "sess-1",
    messageId: `msg-${partial.role}-1`,
    content: partial.content ?? "",
    identity: partial.identity ?? USER,
    timestamp: "2026-04-21T00:00:00.000Z",
    ...partial,
  };
}

describe("renderMessage — with color", () => {
  beforeAll(() => {
    // Clear every signal that would suppress color — otherwise env leakage
    // from a prior test in the suite (e.g. NO_COLOR=1) would cause plain
    // text output and hide the color assertions below.
    delete process.env.NO_COLOR;
    delete process.env.CODEOID_NO_COLOR;
    process.env.FORCE_COLOR = "1";
  });
  afterAll(() => {
    delete process.env.FORCE_COLOR;
  });

  it("renders a user message with header + body + trailing newline", () => {
    const out = renderMessage(
      baseMsg({ role: "user", content: "hello world" }),
      { cols: 80 },
    );
    // Ends with exactly one newline.
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    // Content survives stripping ANSI.
    expect(stripAnsi(out)).toContain("You");
    expect(stripAnsi(out)).toContain("hello world");
    // Contains SGR escapes (color enabled).
    expect(out).toContain(ESC);
  });

  it("renders an assistant message with markdown-like content", () => {
    const out = renderMessage(
      baseMsg({
        role: "assistant",
        content: "Here is **important** text.",
        identity: AGENT,
      }),
      { cols: 80 },
    );
    expect(stripAnsi(out)).toContain("Claude");
    expect(stripAnsi(out)).toContain("important");
  });

  it("renders thinking content with italic dim styling", () => {
    const out = renderMessage(
      baseMsg({
        role: "thinking",
        content: "Let me reason about this…",
        identity: AGENT,
      }),
      { cols: 80 },
    );
    expect(stripAnsi(out)).toContain("thinking");
    expect(stripAnsi(out)).toContain("Let me reason");
  });

  it("renders a tool_call with name, icon, and file path", () => {
    const out = renderMessage(
      baseMsg({
        role: "tool_call",
        content: "",
        identity: AGENT,
        tool: {
          toolId: "t1",
          name: "Read",
          // Cast: the renderer reads `input` via `"input" in tool.state`
          // (defensive lookup). The protocol places `input` on
          // waiting_confirmation, but render-message supports finding it
          // on any state that happens to carry it — which is what we're
          // exercising here. The cast silences the structural-type check
          // while preserving the runtime shape we want to render.
          state: {
            phase: "completed",
            success: true,
            input: { file_path: "/tmp/foo.ts" },
            output: "some output",
            durationMs: 5,
          } as unknown as import("../protocol/types.js").ToolState,
        },
      }),
      { cols: 80 },
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("Read");
    expect(plain).toContain("/tmp/foo.ts");
    expect(plain).toContain("some output");
  });

  it("renders a tool_call Edit with a diff", () => {
    const out = renderMessage(
      baseMsg({
        role: "tool_call",
        content: "",
        identity: AGENT,
        tool: {
          toolId: "t2",
          name: "Edit",
          // See cast note on the Read test above — same reason.
          state: {
            phase: "completed",
            success: true,
            input: {
              file_path: "/tmp/x.ts",
              old_string: "const a = 1;",
              new_string: "const a = 2;",
            },
            output: "",
            durationMs: 3,
          } as unknown as import("../protocol/types.js").ToolState,
        },
      }),
      { cols: 80 },
    );
    const plain = stripAnsi(out);
    // Diff marker rows.
    expect(plain).toContain("- const a = 1;");
    expect(plain).toContain("+ const a = 2;");
  });

  it("renders a system error prominently", () => {
    const out = renderMessage(
      baseMsg({ role: "system", content: "rate-limited, retrying" }),
      { cols: 80 },
    );
    expect(stripAnsi(out)).toContain("⚠");
    expect(stripAnsi(out)).toContain("rate-limited");
  });

  it("renders attachments as a dim summary block", () => {
    const out = renderMessage(
      baseMsg({
        role: "user",
        content: "take a look",
        metadata: {
          attachments: [
            { path: "src/foo.ts", pinned: true },
            { path: "README.md" },
          ],
        },
      }),
      { cols: 80 },
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("attached: 2 files");
    expect(plain).toContain("src/foo.ts");
    expect(plain).toContain("README.md");
  });

  it("returns empty string for unknown roles (forward-compat)", () => {
    const out = renderMessage(
      baseMsg({ role: "unknown" as unknown as "user", content: "x" }),
      { cols: 80 },
    );
    expect(out).toBe("");
  });
});

describe("renderMessage — without color", () => {
  beforeAll(() => {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
  });
  afterAll(() => {
    delete process.env.NO_COLOR;
  });

  it("emits no ANSI escapes when color is disabled", () => {
    const out = renderMessage(
      baseMsg({ role: "user", content: "plain text" }),
      { cols: 80 },
    );
    expect(out).not.toContain(ESC);
    expect(out).toContain("You");
    expect(out).toContain("plain text");
  });
});

describe("renderSessionBanner", () => {
  beforeAll(() => {
    delete process.env.NO_COLOR;
    delete process.env.CODEOID_NO_COLOR;
    process.env.FORCE_COLOR = "1";
  });
  afterAll(() => {
    delete process.env.FORCE_COLOR;
  });

  it("includes the session name and workdir", () => {
    const out = renderSessionBanner({ name: "my-sess", workdir: "/tmp/work" });
    const plain = stripAnsi(out);
    expect(plain).toContain("my-sess");
    expect(plain).toContain("/tmp/work");
    // Has leading + trailing newline so it's visually separated.
    expect(out.startsWith("\n")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });
});
