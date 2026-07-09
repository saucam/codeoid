// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock("./connection", () => ({
  send: vi.fn(),
  request: requestMock,
  newRequestId: () => "r",
  getClient: () => {
    throw new Error("not bootstrapped");
  },
}));

import {
  addUiRequest,
  pendingUiRequest,
  pendingUiRequestCount,
  removeUiRequest,
  respondToUiRequest,
  _resetUiRequestsForTest,
} from "./ui-requests";
import type { SessionUiRequestMsg } from "../protocol/types";

function req(requestId: string, sessionId = "s"): SessionUiRequestMsg {
  return {
    type: "session.ui_request",
    sessionId,
    requestId,
    method: "confirm",
    title: "t",
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  _resetUiRequestsForTest();
  requestMock.mockClear();
});

describe("ui-requests store", () => {
  it("keeps requests oldest-first per session and dedupes re-deliveries", () => {
    addUiRequest(req("a"));
    addUiRequest(req("b"));
    addUiRequest(req("a")); // attach re-delivery — must not duplicate
    expect(pendingUiRequestCount("s")).toBe(2);
    expect(pendingUiRequest("s")?.requestId).toBe("a");
  });

  it("removeUiRequest reveals the next pending; empty session clears", () => {
    addUiRequest(req("a"));
    addUiRequest(req("b"));
    removeUiRequest("s", "a");
    expect(pendingUiRequest("s")?.requestId).toBe("b");
    removeUiRequest("s", "b");
    expect(pendingUiRequest("s")).toBeNull();
    // Unknown ids are a no-op.
    removeUiRequest("s", "ghost");
    removeUiRequest("other", "a");
  });

  it("respondToUiRequest optimistically removes and ships the response", () => {
    addUiRequest(req("a"));
    respondToUiRequest("s", "a", { confirmed: true });
    expect(pendingUiRequestCount("s")).toBe(0);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.ui_response",
        sessionId: "s",
        requestId: "a",
        confirmed: true,
      }),
    );
  });

  it("a rejected response (lost race) does not resurrect the request", async () => {
    requestMock.mockImplementationOnce(() => Promise.reject(new Error("not pending")));
    addUiRequest(req("a"));
    respondToUiRequest("s", "a", { cancelled: true });
    await Promise.resolve();
    expect(pendingUiRequestCount("s")).toBe(0);
  });

  it("pendingUiRequest(null) is null", () => {
    expect(pendingUiRequest(null)).toBeNull();
  });
});
