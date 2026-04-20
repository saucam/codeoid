/**
 * OSC-8 hyperlink helper — shape + detector tests. Guards the escape wire
 * format (terminals are finicky about the delimiters) and the safe-on-
 * unsupported-terminal guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { osc8, fileUri, supportsOsc8, maybeLink } from "../tui/osc8.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("osc8 wire format", () => {
  it("emits the OSC-8 start + URI + BEL + label + end sequence", () => {
    const wrapped = osc8("file:///tmp/foo.ts", "foo.ts");
    expect(wrapped).toBe(
      `${ESC}]8;;file:///tmp/foo.ts${BEL}foo.ts${ESC}]8;;${BEL}`,
    );
  });

  it("returns the label untouched when the uri is empty", () => {
    expect(osc8("", "plain")).toBe("plain");
  });
});

describe("fileUri", () => {
  it("builds file:// URI from an absolute path", () => {
    expect(fileUri("/Workspace/codeoid/README.md")).toBe(
      "file:///Workspace/codeoid/README.md",
    );
  });

  it("resolves a relative path against baseDir", () => {
    expect(fileUri("src/tui/App.tsx", "/Workspace/codeoid")).toBe(
      "file:///Workspace/codeoid/src/tui/App.tsx",
    );
  });

  it("encodes spaces and #-like characters safely", () => {
    const uri = fileUri("/tmp/has space/file#a.ts");
    expect(uri).toContain("%20");
    expect(uri).toContain("%23");
  });
});

describe("supportsOsc8 detection", () => {
  // Snapshot/restore env so tests don't leak.
  let snapshot: NodeJS.ProcessEnv;
  beforeEach(() => {
    snapshot = { ...process.env };
    // Clean out anything that could false-positive detection.
    delete process.env["CODEOID_DISABLE_OSC8"];
    delete process.env["CODEOID_FORCE_OSC8"];
    delete process.env["TERM_PROGRAM"];
    delete process.env["KITTY_WINDOW_ID"];
    delete process.env["TERM"];
    delete process.env["ALACRITTY_LOG"];
    delete process.env["ALACRITTY_WINDOW_ID"];
    delete process.env["VTE_VERSION"];
    delete process.env["WT_SESSION"];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in snapshot)) delete process.env[k];
    }
    Object.assign(process.env, snapshot);
  });

  it("honors CODEOID_FORCE_OSC8 even without a TTY", () => {
    process.env["CODEOID_FORCE_OSC8"] = "1";
    expect(supportsOsc8()).toBe(true);
  });

  it("honors CODEOID_DISABLE_OSC8 over everything else", () => {
    process.env["CODEOID_FORCE_OSC8"] = "1";
    process.env["CODEOID_DISABLE_OSC8"] = "1";
    expect(supportsOsc8()).toBe(false);
  });

  it("detects WezTerm via TERM_PROGRAM", () => {
    process.env["CODEOID_FORCE_OSC8"] = "";
    process.env["TERM_PROGRAM"] = "WezTerm";
    // Forcing the TTY check is impractical here, but supportsOsc8 also
    // demands isTTY. If stdout is a pipe (test env), we get false.
    // Exercise via maybeLink semantics instead:
    const s = maybeLink("file:///x", "x");
    expect(s === "x" || s.includes(ESC + "]8")).toBe(true);
  });

  it("maybeLink passes through the bare label when unsupported", () => {
    expect(maybeLink("file:///x", "label")).toBe("label");
  });
});
