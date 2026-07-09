// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const requestMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock("../../state/connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));

import UiRequestBar from "./UiRequestBar";
import {
  addUiRequest,
  pendingUiRequestCount,
  _resetUiRequestsForTest,
} from "../../state/ui-requests";
import {
  ingestSessionList,
  focusSession,
  _resetSessionsForTest,
} from "../../state/sessions";
import type { SessionInfo, SessionUiRequestMsg } from "../../protocol/types";

function session(): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status: "thinking",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

function uiRequest(over: Partial<SessionUiRequestMsg> = {}): SessionUiRequestMsg {
  return {
    type: "session.ui_request",
    sessionId: "s",
    requestId: "u1",
    method: "confirm",
    title: "Proceed?",
    message: "The extension wants to continue.",
    timestamp: new Date().toISOString(),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  _resetUiRequestsForTest();
  requestMock.mockClear();
});

function setup(req: SessionUiRequestMsg) {
  ingestSessionList([session()]);
  focusSession("s");
  addUiRequest(req);
  return render(() => <UiRequestBar />);
}

describe("UiRequestBar", () => {
  it("renders nothing without a pending request", () => {
    ingestSessionList([session()]);
    focusSession("s");
    const { queryByTestId } = render(() => <UiRequestBar />);
    expect(queryByTestId("ui-request-bar")).toBeNull();
  });

  it("confirm: Yes sends confirmed:true and removes the local copy", async () => {
    const { getByText } = setup(uiRequest());
    fireEvent.click(getByText("Yes"));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.ui_response",
        sessionId: "s",
        requestId: "u1",
        confirmed: true,
      }),
    );
    expect(pendingUiRequestCount("s")).toBe(0);
  });

  it("select: choosing an option sends its value", () => {
    const { getByText, getByLabelText } = setup(
      uiRequest({ method: "select", requestId: "u2", options: ["alpha", "beta"] }),
    );
    fireEvent.click(getByLabelText("beta"));
    fireEvent.click(getByText("Choose"));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "u2", value: "beta" }),
    );
  });

  it("input: submit sends the typed value", () => {
    const { getByText, getByPlaceholderText } = setup(
      uiRequest({ method: "input", requestId: "u3", placeholder: "name" }),
    );
    fireEvent.input(getByPlaceholderText("name"), { target: { value: "pi" } });
    fireEvent.click(getByText("Submit"));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "u3", value: "pi" }),
    );
  });

  it("dismiss sends cancelled:true", () => {
    const { getByText } = setup(uiRequest({ requestId: "u4" }));
    fireEvent.click(getByText("Dismiss"));
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "u4", cancelled: true }),
    );
  });

  it("timed requests show a countdown", () => {
    const { getByTestId } = setup(
      uiRequest({ requestId: "u5", timeoutMs: 30_000 }),
    );
    expect(getByTestId("ui-request-countdown").textContent).toMatch(/\d+s/);
  });
});
