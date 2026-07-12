// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() =>
  vi.fn<(msg: unknown) => Promise<unknown>>(() => Promise.resolve(undefined)),
);
const authMock = vi.hoisted(() => vi.fn(() => undefined as unknown));
vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  authIdentity: authMock,
}));
const fetchModelsMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../state/models", () => ({ fetchModels: fetchModelsMock, modelCatalog: () => [] }));
vi.mock("./SessionExportModal", () => ({ openExportModal: vi.fn() }));

import SessionControls from "./SessionControls";
import {
  getSession,
  ingestSessionList,
  focusSession,
  mergeSession,
  _resetSessionsForTest,
} from "../state/sessions";
import type { SessionInfo } from "../protocol/types";

function sess(providerId?: string): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status: "idle",
    mode: "guarded",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
    ...(providerId ? { providerId } : {}),
  } as SessionInfo;
}

function mockAuth(providers?: string[]): void {
  authMock.mockReturnValue({
    type: "auth.ok",
    identity: { sub: "u", type: "human" },
    scopes: [],
    ...(providers ? { providers } : {}),
  });
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  fetchModelsMock.mockClear();
  requestMock.mockReset();
  requestMock.mockImplementation(() => Promise.resolve(undefined));
  authMock.mockReset();
});

describe("SessionControls mode dropdown dismissal", () => {
  it("opens on click and closes on Escape (not just mouse-leave)", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByText } = render(() => <SessionControls />);

    // Closed initially — the option rows aren't in the DOM.
    expect(queryByText("interactive")).toBeNull();

    fireEvent.click(getByTitle("Cycle execution mode"));
    expect(queryByText("interactive")).not.toBeNull(); // menu open

    // Escape (keyboard/touch users can't trigger onMouseLeave) closes it.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(queryByText("interactive")).toBeNull();
  });

  it("closes on an outside pointer-down", () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle("Cycle execution mode"));
    expect(queryByText("interactive")).not.toBeNull();
    fireEvent.pointerDown(document.body); // click somewhere outside the menu
    expect(queryByText("interactive")).toBeNull();
  });
});

describe("ModePicker requests", () => {
  const MODE_TITLE = "Cycle execution mode";

  it("sends session.set_mode via request() and closes the menu on resolve", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText, queryByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(MODE_TITLE));
    fireEvent.click(getByText("autonomous"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session.set_mode",
          sessionId: "s",
          mode: "autonomous",
        }),
      ),
    );
    await waitFor(() => expect(queryByText("autonomous")).toBeNull()); // menu closed
  });

  it("keeps the menu open and surfaces a rejection inline", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("mode locked by policy")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText, queryByText, findByText } = render(() => (
      <SessionControls />
    ));
    fireEvent.click(getByTitle(MODE_TITLE));
    fireEvent.click(getByText("interactive"));
    expect(await findByText(/mode locked/)).toBeTruthy();
    expect(queryByText("autonomous")).not.toBeNull(); // still open, retry possible
  });

  it("disables the options while a request is in flight", () => {
    requestMock.mockImplementationOnce(() => new Promise(() => {}));
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(MODE_TITLE));
    const opt = getByText("interactive").closest("button") as HTMLButtonElement;
    fireEvent.click(opt);
    expect(opt.disabled).toBe(true);
  });
});

describe("ModelPicker custom model id", () => {
  const MODEL_TITLE = "Switch model (next turn applies)";

  /** The picker's open state is module-level (bare `/model` opens it), so a
   * previous test can leave it open — only toggle when it's closed. */
  function openModelMenu(
    getByTitle: (t: string) => HTMLElement,
    queryByPlaceholderText: (t: string) => HTMLElement | null,
  ): HTMLInputElement {
    if (!queryByPlaceholderText("custom model id")) {
      fireEvent.click(getByTitle(MODEL_TITLE));
    }
    return queryByPlaceholderText("custom model id") as HTMLInputElement;
  }

  it("submits via request() and keeps the typed id on rejection", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("unknown model: clade-5-typo")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByPlaceholderText, findByText } = render(() => (
      <SessionControls />
    ));
    const input = openModelMenu(getByTitle, queryByPlaceholderText);
    fireEvent.input(input, { target: { value: "clade-5-typo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.set_model",
        sessionId: "s",
        model: "clade-5-typo",
      }),
    );
    // Rejection surfaces inline; the text stays put so the user can fix it.
    expect(await findByText(/unknown model/)).toBeTruthy();
    expect(input.value).toBe("clade-5-typo");
  });

  it("clears the input and closes the menu on resolve", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, queryByPlaceholderText } = render(() => <SessionControls />);
    const input = openModelMenu(getByTitle, queryByPlaceholderText);
    fireEvent.input(input, { target: { value: "claude-sonnet-4-5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.set_model", model: "claude-sonnet-4-5" }),
      ),
    );
    await waitFor(() => expect(queryByPlaceholderText("custom model id")).toBeNull());
  });
});

describe("RotateButton", () => {
  const ROTATE_TITLE =
    "Rotate the Claude Code backing context (refresh skills/settings; memory preserved)";

  it("rotates via request(), disabling while in flight (no double-fire)", async () => {
    let resolveReq!: (v: unknown) => void;
    requestMock.mockImplementationOnce(
      () => new Promise((r) => (resolveReq = r)),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle } = render(() => <SessionControls />);
    const btn = getByTitle(ROTATE_TITLE) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn); // second click while in flight must not re-send
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.rotate", sessionId: "s" }),
    );
    expect(btn.disabled).toBe(true);
    resolveReq(undefined);
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("surfaces a rotate rejection inline", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("rotate failed: harness busy")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(ROTATE_TITLE));
    expect(await findByText(/rotate failed/)).toBeTruthy();
  });
});

describe("DestroyButton", () => {
  const DESTROY_TITLE = "Destroy this session";

  it("removes the session only after the daemon confirms", async () => {
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(DESTROY_TITLE));
    fireEvent.click(getByText("yes"));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.destroy", sessionId: "s" }),
    );
    // Removal happens on resolve, not optimistically at click time.
    await waitFor(() => expect(getSession("s")).toBeUndefined());
  });

  it("keeps the session and shows the error inline when destroy is rejected", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("session is mid-turn")),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(DESTROY_TITLE));
    fireEvent.click(getByText("yes"));
    expect(await findByText(/mid-turn/)).toBeTruthy();
    expect(getSession("s")).toBeDefined(); // list did NOT desync
  });

  it("disables the confirm button while the destroy is in flight", async () => {
    let resolveReq!: (v: unknown) => void;
    requestMock.mockImplementationOnce(
      () => new Promise((r) => (resolveReq = r)),
    );
    ingestSessionList([sess()]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(DESTROY_TITLE));
    const yes = getByText("yes") as HTMLButtonElement;
    fireEvent.click(yes);
    expect(yes.disabled).toBe(true);
    expect(getSession("s")).toBeDefined(); // still present while pending
    resolveReq(undefined);
    await waitFor(() => expect(getSession("s")).toBeUndefined());
  });
});

describe("ProviderPicker", () => {
  const PICKER_TITLE = "Switch this session's backend (/provider <id>)";

  it("is hidden on single-backend and legacy daemons", () => {
    mockAuth(["claude"]);
    ingestSessionList([sess()]);
    focusSession("s");
    const { queryByTitle } = render(() => <SessionControls />);
    expect(queryByTitle(PICKER_TITLE)).toBeNull();
    cleanup();

    mockAuth(undefined); // legacy daemon: no providers advertised
    ingestSessionList([sess()]);
    focusSession("s");
    const { queryByTitle: q2 } = render(() => <SessionControls />);
    expect(q2(PICKER_TITLE)).toBeNull();
  });

  it("shows the current backend and switches via session.set_provider", async () => {
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByText, getByTitle } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PICKER_TITLE));
    fireEvent.click(getByText("pi"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "session.set_provider",
          sessionId: "s",
          providerId: "pi",
        }),
      ),
    );
  });

  it("selecting the current backend is a no-op close", () => {
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("pi")]);
    focusSession("s");
    const { getAllByText, getByTitle } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PICKER_TITLE));
    // First "pi" is the button label, the menu entry is the last match.
    const entries = getAllByText("pi");
    fireEvent.click(entries[entries.length - 1]!);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("surfaces the daemon's rejection inline (mid-turn switch)", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Session is mid-turn — interrupt it, then switch providers")),
    );
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByText, getByTitle, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PICKER_TITLE));
    fireEvent.click(getByText("pi"));
    expect(await findByText(/mid-turn/)).toBeTruthy();
  });
});

describe("ForkButton", () => {
  const PLAIN_TITLE = "Branch this conversation into a new session (/fork)";
  const MENU_TITLE =
    "Branch this conversation — same backend, or continue it on another (/fork [backend])";

  it("single-backend daemon: a plain fork button that forks in place", async () => {
    requestMock.mockResolvedValueOnce({ id: "fork-1", name: "s (fork)", providerId: "claude" });
    mockAuth(["claude"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(PLAIN_TITLE));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.fork", sessionId: "s" }),
      ),
    );
    // The plain fork carries NO providerId (same backend).
    expect(requestMock.mock.calls[0]![0]).not.toHaveProperty("providerId");
  });

  it("multi-backend daemon: dropdown offers fork-onto each OTHER backend", async () => {
    requestMock.mockResolvedValueOnce({ id: "fork-2", name: "s (fork)", providerId: "codex" });
    mockAuth(["claude", "codex", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(MENU_TITLE));
    // The "continue on" section lists the OTHER backends.
    expect(getByText("continue on")).toBeTruthy();
    expect(getByText("codex")).toBeTruthy();
    fireEvent.click(getByText("codex"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.fork", sessionId: "s", providerId: "codex" }),
      ),
    );
  });

  it("surfaces a fork rejection inline", async () => {
    requestMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Cannot fork a conductor session")),
    );
    mockAuth(["claude", "pi"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    const { getByTitle, getByText, findByText } = render(() => <SessionControls />);
    fireEvent.click(getByTitle(MENU_TITLE));
    fireEvent.click(getByText("fork (same backend)"));
    expect(await findByText(/Cannot fork/)).toBeTruthy();
  });
});

describe("ModelPicker — catalog follows the backend", () => {
  it("fetches the focused session's backend catalog on mount", () => {
    mockAuth(["claude", "codex"]);
    ingestSessionList([sess("codex")]);
    focusSession("s");
    render(() => <SessionControls />);
    // Not the daemon default — the SESSION's backend.
    expect(fetchModelsMock).toHaveBeenCalledWith("codex");
  });

  it("refetches when the session's backend switches (the reported bug)", async () => {
    mockAuth(["claude", "codex"]);
    ingestSessionList([sess("claude")]);
    focusSession("s");
    render(() => <SessionControls />);
    expect(fetchModelsMock).toHaveBeenCalledWith("claude");
    fetchModelsMock.mockClear();

    // A `/provider` switch arrives as an info_update flipping providerId.
    mergeSession({ id: "s", providerId: "codex" });
    await waitFor(() => expect(fetchModelsMock).toHaveBeenCalledWith("codex"));
  });
});
