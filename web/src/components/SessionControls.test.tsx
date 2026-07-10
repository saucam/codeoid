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
vi.mock("../state/models", () => ({ fetchModels: vi.fn(), modelCatalog: () => [] }));
vi.mock("./SessionExportModal", () => ({ openExportModal: vi.fn() }));

import SessionControls from "./SessionControls";
import {
  ingestSessionList,
  focusSession,
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
