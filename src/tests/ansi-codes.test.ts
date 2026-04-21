/**
 * Low-level ANSI primitives — style application, color detection, width
 * math, and soft-wrap. Guards the invariants the scrollback writer relies
 * on (style always closes with a reset, wrap preserves content, width
 * math agrees with what terminals actually display).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  SGR,
  sgr,
  bold,
  red,
  supportsColor,
  stripAnsi,
  displayWidth,
  wrapLine,
  resetAll,
} from "../tui/ansi/codes.js";

const ESC = "\x1b";
const CSI = `${ESC}[`;

describe("supportsColor env handling", () => {
  let snapshot: NodeJS.ProcessEnv;
  beforeEach(() => {
    snapshot = { ...process.env };
    // Clean out every signal that could force a decision.
    delete process.env["NO_COLOR"];
    delete process.env["CODEOID_NO_COLOR"];
    delete process.env["FORCE_COLOR"];
    delete process.env["TERM"];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in snapshot)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  });

  it("respects NO_COLOR=1", () => {
    process.env["NO_COLOR"] = "1";
    expect(supportsColor()).toBe(false);
  });

  it("respects TERM=dumb", () => {
    process.env["TERM"] = "dumb";
    expect(supportsColor()).toBe(false);
  });

  it("respects CODEOID_NO_COLOR", () => {
    process.env["CODEOID_NO_COLOR"] = "1";
    expect(supportsColor()).toBe(false);
  });

  it("FORCE_COLOR wins over TTY=false", () => {
    process.env["FORCE_COLOR"] = "1";
    expect(supportsColor()).toBe(true);
  });
});

describe("sgr wrapping", () => {
  beforeEach(() => {
    process.env["FORCE_COLOR"] = "1";
    delete process.env["NO_COLOR"];
  });
  afterEach(() => {
    delete process.env["FORCE_COLOR"];
  });

  it("wraps text with the requested SGR codes + closing reset", () => {
    const out = sgr("hi", "bold", "red");
    expect(out).toBe(`${CSI}${SGR.bold};${SGR.red}m hi${CSI}${SGR.reset}m`.replace(" ", ""));
  });

  it("always closes with a reset so style never leaks into follow-up writes", () => {
    const out = bold("x");
    expect(out.endsWith(`${CSI}${SGR.reset}m`)).toBe(true);
  });

  it("no-op on empty text", () => {
    expect(bold("")).toBe("");
  });

  it("emits bare text when color is disabled", () => {
    process.env["NO_COLOR"] = "1";
    delete process.env["FORCE_COLOR"];
    expect(red("hello")).toBe("hello");
  });

  it("resetAll is empty when color is disabled", () => {
    process.env["NO_COLOR"] = "1";
    delete process.env["FORCE_COLOR"];
    expect(resetAll()).toBe("");
  });
});

describe("stripAnsi", () => {
  it("removes CSI SGR sequences", () => {
    const styled = `${CSI}1;31mhi${CSI}0m`;
    expect(stripAnsi(styled)).toBe("hi");
  });

  it("removes OSC hyperlink sequences", () => {
    const link = `${ESC}]8;;file:///x\x07label${ESC}]8;;\x07`;
    expect(stripAnsi(link)).toBe("label");
  });

  it("is a no-op on plain text", () => {
    expect(stripAnsi("plain text — no codes")).toBe("plain text — no codes");
  });
});

describe("displayWidth", () => {
  it("counts ASCII as one column per char", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("counts CJK as two columns", () => {
    expect(displayWidth("日本語")).toBe(6);
  });

  it("counts common emoji as two columns", () => {
    expect(displayWidth("🚀")).toBe(2);
  });

  it("ignores ANSI in the width calculation", () => {
    expect(displayWidth(red("hi"))).toBe(2);
  });

  it("treats zero-width joiners as width-0", () => {
    // a + combining acute accent: renders as one column
    expect(displayWidth("a\u0301")).toBe(1);
  });
});

describe("wrapLine", () => {
  it("returns the line untouched when it fits", () => {
    expect(wrapLine("short", 80)).toEqual(["short"]);
  });

  it("soft-breaks at the last space within the column budget", () => {
    const line = "alpha beta gamma delta";
    const wrapped = wrapLine(line, 12);
    // First segment should end before "gamma" since "alpha beta gamma" is 16 chars.
    expect(wrapped.length).toBeGreaterThan(1);
    // Every line in the result should have width <= cols.
    for (const ln of wrapped) {
      expect(displayWidth(ln)).toBeLessThanOrEqual(12);
    }
    // The visible content must be preserved modulo whitespace.
    const joined = wrapped.join(" ");
    expect(stripAnsi(joined).replace(/\s+/g, " ")).toContain("alpha");
    expect(stripAnsi(joined).replace(/\s+/g, " ")).toContain("delta");
  });

  it("hard-breaks when there are no spaces", () => {
    const line = "a".repeat(30);
    const wrapped = wrapLine(line, 10);
    for (const ln of wrapped) {
      expect(ln.length).toBeLessThanOrEqual(10);
    }
    expect(wrapped.join("").length).toBe(30);
  });
});
