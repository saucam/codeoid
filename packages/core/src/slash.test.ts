import { describe, expect, it, mock } from "bun:test";
import { dispatchSlash, parseSlash, type SlashContext } from "./slash.js";

function ctx(): SlashContext & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    sessionId: "s1",
    send: (m) => void sent.push(m),
    newRequestId: () => "req-1",
    removeSession: mock(),
  };
}

describe("parseSlash", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlash("hello world")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });

  it("parses /new with optional workdir", () => {
    expect(parseSlash("/new alpha")).toEqual({ kind: "new", name: "alpha" });
    expect(parseSlash("/new alpha /tmp")).toEqual({
      kind: "new",
      name: "alpha",
      workdir: "/tmp",
    });
    expect(parseSlash("/new alpha /tmp/with spaces")).toEqual({
      kind: "new",
      name: "alpha",
      workdir: "/tmp/with spaces",
    });
  });

  it("rejects /new without a name", () => {
    expect(() => parseSlash("/new")).toThrow();
  });

  it("parses /rename and concatenates trailing args", () => {
    expect(parseSlash("/rename my session")).toEqual({
      kind: "rename",
      name: "my session",
    });
  });

  it("parses lifecycle verbs", () => {
    expect(parseSlash("/destroy")).toEqual({ kind: "destroy" });
    expect(parseSlash("/interrupt")).toEqual({ kind: "interrupt" });
    expect(parseSlash("/rotate")).toEqual({ kind: "rotate" });
    expect(parseSlash("/help")).toEqual({ kind: "help" });
    expect(parseSlash("/clear")).toEqual({ kind: "clear" });
    expect(parseSlash("/who")).toEqual({ kind: "who" });
    expect(parseSlash("/whoami")).toEqual({ kind: "who" });
  });

  it("parses /mode with single-letter aliases", () => {
    expect(parseSlash("/mode i")).toEqual({ kind: "mode", mode: "interactive" });
    expect(parseSlash("/mode auto")).toEqual({ kind: "mode", mode: "guarded" });
    expect(parseSlash("/mode x 50")).toEqual({
      kind: "mode",
      mode: "autonomous",
      maxTurns: 50,
    });
  });

  it("rejects unknown modes", () => {
    expect(() => parseSlash("/mode wat")).toThrow(/unknown mode/);
  });

  it("parses /model with optional fallback", () => {
    expect(parseSlash("/model opus")).toEqual({ kind: "model", model: "opus" });
    expect(parseSlash("/model opus sonnet")).toEqual({
      kind: "model",
      model: "opus",
      fallback: "sonnet",
    });
  });

  it("bare /model opens the picker instead of erroring", () => {
    expect(parseSlash("/model")).toEqual({ kind: "model-picker" });
  });

  it("rejects unknown verbs", () => {
    expect(() => parseSlash("/banana")).toThrow(/unknown slash command/);
  });
});

describe("dispatchSlash", () => {
  it("/new emits session.create", () => {
    const c = ctx();
    dispatchSlash({ kind: "new", name: "demo", workdir: "/tmp" }, c);
    expect(c.sent).toEqual([
      { type: "session.create", id: "req-1", name: "demo", workdir: "/tmp" },
    ]);
  });

  it("/new without workdir defaults to '.'", () => {
    const c = ctx();
    dispatchSlash({ kind: "new", name: "demo" }, c);
    expect(c.sent[0]).toMatchObject({ type: "session.create", workdir: "." });
  });

  it("/rename emits session.rename", () => {
    const c = ctx();
    dispatchSlash({ kind: "rename", name: "renamed" }, c);
    expect(c.sent[0]).toMatchObject({ type: "session.rename", name: "renamed" });
  });

  it("/destroy sends + locally removes the session", () => {
    const c = ctx();
    dispatchSlash({ kind: "destroy" }, c);
    expect(c.sent[0]).toMatchObject({ type: "session.destroy" });
    expect(c.removeSession).toHaveBeenCalledWith("s1");
  });

  it("/interrupt and /rotate send their verbs", () => {
    const c = ctx();
    dispatchSlash({ kind: "interrupt" }, c);
    dispatchSlash({ kind: "rotate" }, c);
    expect(c.sent[0]).toMatchObject({ type: "session.interrupt" });
    expect(c.sent[1]).toMatchObject({ type: "session.rotate" });
  });

  it("/mode emits session.set_mode with optional maxTurns", () => {
    const c = ctx();
    dispatchSlash({ kind: "mode", mode: "autonomous", maxTurns: 100 }, c);
    expect(c.sent[0]).toMatchObject({
      type: "session.set_mode",
      mode: "autonomous",
      maxTurns: 100,
    });
  });

  it("/model emits session.set_model with optional fallback", () => {
    const c = ctx();
    dispatchSlash({ kind: "model", model: "opus", fallback: null }, c);
    expect(c.sent[0]).toMatchObject({
      type: "session.set_model",
      model: "opus",
      fallbackModel: null,
    });
  });

  it("/help and /clear are pure UI and emit nothing", () => {
    const c = ctx();
    dispatchSlash({ kind: "help" }, c);
    dispatchSlash({ kind: "clear" }, c);
    expect(c.sent).toEqual([]);
  });

  it("/who invokes the identity hook and emits nothing", () => {
    const showIdentity = mock();
    const c = { ...ctx(), showIdentity };
    dispatchSlash({ kind: "who" }, c);
    expect(showIdentity).toHaveBeenCalledTimes(1);
    expect(c.sent).toEqual([]);
  });

  it("parses capabilities aliases into the right tab", () => {
    expect(parseSlash("/agents")).toEqual({ kind: "capabilities", tab: "agents" });
    expect(parseSlash("/agent")).toEqual({ kind: "capabilities", tab: "agents" });
    expect(parseSlash("/skills")).toEqual({ kind: "capabilities", tab: "skills" });
    expect(parseSlash("/skill")).toEqual({ kind: "capabilities", tab: "skills" });
    expect(parseSlash("/mcp")).toEqual({ kind: "capabilities", tab: "mcp" });
    expect(parseSlash("/hooks")).toEqual({ kind: "capabilities", tab: "hooks" });
    expect(parseSlash("/hook")).toEqual({ kind: "capabilities", tab: "hooks" });
  });

  it("parses /export and /import + alias forms", () => {
    expect(parseSlash("/export")).toEqual({ kind: "export" });
    expect(parseSlash("/share")).toEqual({ kind: "export" });
    expect(parseSlash("/import")).toEqual({ kind: "import" });
    expect(parseSlash("/fork")).toEqual({ kind: "fork" });
  });

  it("dispatchSlash routes /export and /import to UI hooks", () => {
    const showExport = mock();
    const showImport = mock();
    const c = { ...ctx(), showExport, showImport };
    dispatchSlash({ kind: "export" }, c);
    dispatchSlash({ kind: "import" }, c);
    dispatchSlash({ kind: "fork" }, c);
    expect(showExport).toHaveBeenCalledTimes(1);
    expect(showImport).toHaveBeenCalledTimes(2);
    expect(c.sent).toEqual([]);
  });

  it("dispatchSlash routes /agents /skills /mcp /hooks to showCapabilities", () => {
    const showCapabilities = mock();
    const c = { ...ctx(), showCapabilities };
    dispatchSlash({ kind: "capabilities", tab: "agents" }, c);
    dispatchSlash({ kind: "capabilities", tab: "skills" }, c);
    dispatchSlash({ kind: "capabilities", tab: "mcp" }, c);
    dispatchSlash({ kind: "capabilities", tab: "hooks" }, c);
    expect(showCapabilities).toHaveBeenCalledTimes(4);
    expect(showCapabilities).toHaveBeenNthCalledWith(1, "agents");
    expect(showCapabilities).toHaveBeenNthCalledWith(2, "skills");
    expect(showCapabilities).toHaveBeenNthCalledWith(3, "mcp");
    expect(showCapabilities).toHaveBeenNthCalledWith(4, "hooks");
    expect(c.sent).toEqual([]);
  });
});

describe("provider-command passthrough", () => {
  it("unknown verbs still throw without a passthrough predicate", () => {
    expect(() => parseSlash("/review the diff")).toThrow(/unknown slash command/);
  });

  it("returns null (plain prompt text) when the predicate matches", () => {
    const isProviderCommand = (name: string) => name === "review";
    expect(parseSlash("/review the diff", { isProviderCommand })).toBeNull();
    // Case-insensitive: the verb is lowercased before the predicate runs.
    expect(parseSlash("/REVIEW now", { isProviderCommand })).toBeNull();
    // Non-matching verbs still throw.
    expect(() => parseSlash("/nonsense", { isProviderCommand })).toThrow(
      /unknown slash command/,
    );
  });

  it("built-ins always win over provider commands of the same name", () => {
    // A provider exposing "/help" must not shadow the client's help modal.
    const isProviderCommand = () => true;
    expect(parseSlash("/help", { isProviderCommand })).toEqual({ kind: "help" });
  });
});
