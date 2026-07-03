/**
 * Security: untrusted content (model output, tool stdout, streamed deltas)
 * must not be able to drive the user's terminal via embedded control
 * sequences (OSC 52 clipboard writes, cursor/screen control, DCS, …). The
 * renderer's own SGR styling and OSC-8 file links must survive.
 */

import { describe, it, expect } from "bun:test";
import { sanitizeTerminalOutput, stripAnsi } from "../tui/ansi/codes.js";
import { ScrollbackWriter } from "../tui/ansi/scrollback-writer.js";
import { SYSTEM_IDENTITY } from "../protocol/types.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("sanitizeTerminalOutput", () => {
  it("passes plain text through unchanged", () => {
    expect(sanitizeTerminalOutput("hello world")).toBe("hello world");
    expect(sanitizeTerminalOutput("")).toBe("");
    expect(sanitizeTerminalOutput("line1\nline2\tcol\r\n")).toBe(
      "line1\nline2\tcol\r\n",
    );
  });

  it("strips OSC 52 clipboard-write sequences", () => {
    const attack = `before${ESC}]52;c;bWFsaWNpb3Vz${BEL}after`;
    const out = sanitizeTerminalOutput(attack);
    expect(out).toBe("beforeafter");
    expect(out).not.toContain("]52");
    expect(out).not.toContain(ESC);
  });

  it("strips OSC 0/1/2 title-spoofing sequences (BEL and ST terminated)", () => {
    expect(sanitizeTerminalOutput(`x${ESC}]0;pwned${BEL}y`)).toBe("xy");
    expect(sanitizeTerminalOutput(`x${ESC}]2;pwned${ESC}\\y`)).toBe("xy");
  });

  it("strips non-SGR CSI (cursor moves, screen clears, mode sets)", () => {
    expect(sanitizeTerminalOutput(`a${ESC}[2Jb`)).toBe("ab"); // clear screen
    expect(sanitizeTerminalOutput(`a${ESC}[10Ab`)).toBe("ab"); // cursor up
    expect(sanitizeTerminalOutput(`a${ESC}[?25lb`)).toBe("ab"); // hide cursor
  });

  it("strips DCS / APC / PM / SOS device-control strings", () => {
    expect(sanitizeTerminalOutput(`a${ESC}Pq#0;1;2${ESC}\\b`)).toBe("ab"); // DCS
    expect(sanitizeTerminalOutput(`a${ESC}_evil${ESC}\\b`)).toBe("ab"); // APC
  });

  it("strips lone C0 controls but keeps tab/newline/carriage-return/bell", () => {
    expect(sanitizeTerminalOutput("a\bb")).toBe("ab"); // backspace
    expect(sanitizeTerminalOutput("a\x00b\x1fc")).toBe("abc"); // NUL, unit sep
    expect(sanitizeTerminalOutput("a\tb\nc\rd")).toBe("a\tb\nc\rd");
    // BEL survives — it terminates OSC-8 links; a lone bell is only a beep.
    expect(sanitizeTerminalOutput(`a${BEL}b`)).toBe(`a${BEL}b`);
  });

  it("PRESERVES SGR colour/style sequences the renderer emits", () => {
    const styled = `${ESC}[31mred${ESC}[0m ${ESC}[1;33mbold-yellow${ESC}[0m`;
    expect(sanitizeTerminalOutput(styled)).toBe(styled);
  });

  it("PRESERVES OSC-8 hyperlinks but strips a smuggled OSC 52 beside them", () => {
    const link = `${ESC}]8;;file:///tmp/x${BEL}open${ESC}]8;;${BEL}`;
    expect(sanitizeTerminalOutput(link)).toBe(link);
    const mixed = `${link}${ESC}]52;c;YWJj${BEL}`;
    expect(sanitizeTerminalOutput(mixed)).toBe(link);
  });

  it("strips a dangling escape introducer at end-of-chunk (cross-write safety)", () => {
    // A chunk ending in `ESC` or `ESC [ …` (no final byte) must not survive to
    // be completed by the next write's bytes.
    expect(sanitizeTerminalOutput("foo\x1b")).toBe("foo");
    expect(sanitizeTerminalOutput("foo\x1b[")).toBe("foo");
    expect(sanitizeTerminalOutput("foo\x1b[31")).toBe("foo");
    expect(sanitizeTerminalOutput("foo\x1b[?25")).toBe("foo");
    // A COMPLETE trailing SGR is still preserved.
    expect(sanitizeTerminalOutput(`foo${ESC}[31m`)).toBe(`foo${ESC}[31m`);
    // Simulate a split attack: `ESC[` at the end of one chunk + `2J` at the
    // start of the next must NOT reconstruct a clear-screen after sanitizing.
    const a = sanitizeTerminalOutput("line\x1b[");
    const b = sanitizeTerminalOutput("2Jrest");
    expect(a + b).not.toContain(`${ESC}[2J`);
  });

  it("is stricter than stripAnsi (which misses cursor/screen CSI)", () => {
    const attack = `x${ESC}[2Jy`; // clear-screen CSI embedded in content
    // stripAnsi (built for width math) leaves the cursor/screen CSI in place …
    expect(stripAnsi(attack)).toContain(`${ESC}[2J`);
    // … sanitizeTerminalOutput removes it.
    expect(sanitizeTerminalOutput(attack)).toBe("xy");
  });
});

describe("ScrollbackWriter neutralizes injected escapes at the write boundary", () => {
  it("drops an OSC 52 payload smuggled in a streamed delta", () => {
    const lines: string[] = [];
    const writer = new ScrollbackWriter({
      log: (line) => lines.push(line),
      getCols: () => 80,
    });
    writer.streamDelta("sess-1", {
      messageId: "msg-1",
      role: "assistant",
      content: `hello${ESC}]52;c;bWFs${BEL}world\n`,
      identity: SYSTEM_IDENTITY,
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("]52");
    expect(joined).toContain("helloworld");
  });
});
