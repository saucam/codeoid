// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn());
const authMock = vi.hoisted(() => vi.fn());
vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  refreshSessions: vi.fn(() => Promise.resolve([])),
  authIdentity: authMock,
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));

import NewSessionModal, { openNewSessionModal } from "./NewSessionModal";
import { _resetSessionsForTest } from "../state/sessions";

function authOk(providers?: string[]) {
  return {
    type: "auth.ok",
    identity: { sub: "u", type: "human" },
    scopes: [],
    ...(providers ? { providers } : {}),
  };
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  requestMock.mockReset();
  authMock.mockReset();
});

describe("NewSessionModal provider picker", () => {
  it("hides the picker when the daemon advertises no providers (legacy)", () => {
    authMock.mockReturnValue(authOk());
    const { queryByText } = render(() => <NewSessionModal />);
    openNewSessionModal();
    expect(queryByText("Backend")).toBeNull();
  });

  it("defaults to the first provider and omits providerId from the create", async () => {
    authMock.mockReturnValue(authOk(["claude", "pi"]));
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    expect(getByText("claude (default)")).toBeTruthy();
    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "demo" },
    });
    fireEvent.click(getByText("create"));
    await waitFor(() => expect(requestMock).toHaveBeenCalled());
    const sent = requestMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.type).toBe("session.create");
    expect("providerId" in sent).toBe(false);
  });

  it("sends the chosen non-default provider", async () => {
    authMock.mockReturnValue(authOk(["claude", "pi"]));
    requestMock.mockResolvedValue({ id: "s-new", name: "n", workdir: "/w" });
    const { getByText, getByPlaceholderText } = render(() => <NewSessionModal />);
    openNewSessionModal();

    fireEvent.click(getByText("pi"));
    fireEvent.input(getByPlaceholderText("e.g. shield-refactor"), {
      target: { value: "pi-session" },
    });
    fireEvent.click(getByText("create"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session.create", providerId: "pi" }),
      ),
    );
  });
});
