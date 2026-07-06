/**
 * Legacy readline client — stream rendering + ANSI sanitization (#92).
 *
 * The `codeoid attach` readline client writes model/tool content straight to
 * the TTY. #91 wired sanitizeTerminalOutput into the TUI + web renderers but
 * deferred this path because the rendering lived in a closure. That logic is
 * now the pure, exported renderStreamMessage; these tests drive it directly
 * and assert every untrusted field is stripped of terminal-control escapes
 * (OSC 52 clipboard, cursor moves, DCS) while our own SGR framing survives.
 */

import { describe, it, expect } from "bun:test";
import {
  renderStreamMessage,
  newStreamRenderState,
} from "../terminal/client.js";
import type { DaemonMessage } from "../protocol/types.js";

// An OSC 52 clipboard-write sequence — the headline injection vector.
const OSC52 = "\x1b]52;c;ZXZpbA==\x07";
// A cursor-move CSI and a lone DCS opener.
const CURSOR = "\x1b[2J\x1b[H";

function noEscapes(s: string): void {
  // No OSC introducer, no DCS, no raw CSI beyond our own known SGR codes.
  expect(s).not.toContain("\x1b]"); // OSC
  expect(s).not.toContain("\x1b]52");
  expect(s).not.toContain("\x1bP"); // DCS
  expect(s).not.toContain("\x1b[2J"); // erase-display CSI
}

describe("renderStreamMessage — sanitization", () => {
  it("strips OSC 52 from assistant content but keeps the trailing newline", () => {
    const out = renderStreamMessage(
      { type: "session.message", role: "assistant", content: `hello${OSC52}world` } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("strips a cursor-move CSI from user content, keeps our cyan framing", () => {
    const out = renderStreamMessage(
      { type: "session.message", role: "user", content: `${CURSOR}hi` } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("\x1b[36m"); // our own cyan prompt framing survives
    expect(out).toContain("hi");
  });

  it("sanitizes identity.name", () => {
    const out = renderStreamMessage(
      { type: "session.message", role: "user", content: "x", identity: { name: `evil${OSC52}` } } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("evil");
  });

  it("sanitizes tool name + description and records the approval id", () => {
    const state = newStreamRenderState();
    const out = renderStreamMessage(
      {
        type: "session.message",
        role: "tool_call",
        tool: {
          name: `Bash${OSC52}`,
          state: { phase: "waiting_confirmation", approvalId: "appr-1", description: `rm -rf${OSC52} /` },
        },
      } as DaemonMessage,
      state,
    );
    noEscapes(out);
    expect(out).toContain("Bash");
    expect(out).toContain("rm -rf");
    expect(out).toContain("Type 'yes' to approve");
    expect(state.latestApprovalId).toBe("appr-1");
  });

  it("sanitizes streaming deltas and dedupes the committed assistant message", () => {
    const state = newStreamRenderState();
    const delta = renderStreamMessage(
      { type: "session.message.delta", messageId: "m1", contentAppend: `chunk${OSC52}` } as DaemonMessage,
      state,
    );
    noEscapes(delta);
    expect(delta).toContain("chunk");
    expect(state.streamingAssistantMsgId).toBe("m1");

    // The committed assistant message for the same id must not re-print content —
    // just close the streamed line with a newline.
    const committed = renderStreamMessage(
      { type: "session.message", role: "assistant", messageId: "m1", content: "chunk" } as DaemonMessage,
      state,
    );
    expect(committed).toBe("\n");
    expect(state.streamingAssistantMsgId).toBeNull();
  });

  it("sanitizes every entry in a scrollback replay", () => {
    const out = renderStreamMessage(
      {
        type: "scrollback.replay",
        messages: [
          { type: "session.message", role: "assistant", content: `a${OSC52}` },
          { type: "session.message", role: "user", content: `u${CURSOR}`, identity: { name: `n${OSC52}` } },
          { type: "session.message", role: "tool_call", tool: { name: `T${OSC52}` } },
          { type: "session.message", role: "system", content: `s${OSC52}` },
        ],
      } as DaemonMessage,
      newStreamRenderState(),
    );
    noEscapes(out);
    expect(out).toContain("--- scrollback (4 messages) ---");
    expect(out).toContain("--- end scrollback ---");
  });

  it("returns empty string for unhandled message types", () => {
    expect(renderStreamMessage({ type: "auth.ok" } as DaemonMessage, newStreamRenderState())).toBe("");
  });

  it("renders status_change without leaking (controlled enum)", () => {
    const out = renderStreamMessage(
      { type: "session.status_change", status: "thinking" } as DaemonMessage,
      newStreamRenderState(),
    );
    expect(out).toBe("\n[status] thinking\n");
  });
});
