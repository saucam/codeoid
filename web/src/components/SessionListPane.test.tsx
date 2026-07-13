// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../state/connection", () => ({
  send: vi.fn(),
  request: vi.fn(() => Promise.resolve(undefined)),
  newRequestId: () => "r",
  authIdentity: () => undefined,
}));
// Not under test — stub the heavy child panels so this focuses on the filter.
vi.mock("./files/FileTree", () => ({ default: () => null }));
vi.mock("./AnalyticsPanel", () => ({ default: () => null }));
vi.mock("./NewSessionModal", () => ({ openNewSessionModal: vi.fn() }));

import SessionListPane from "./SessionListPane";
import { ingestSessionList, _resetSessionsForTest } from "../state/sessions";
import type { SessionInfo } from "../protocol/types";

function sess(id: string, name: string, workdir = "/tmp"): SessionInfo {
  return {
    id,
    name,
    workdir,
    status: "idle",
    mode: "guarded",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
});

describe("SessionListPane — session filter", () => {
  it("filters the visible sessions by name or workdir as you type", () => {
    ingestSessionList([
      sess("a", "alpha", "/repo/a"),
      sess("b", "beta", "/repo/b"),
      sess("c", "gamma redteam", "/work/rt"),
    ]);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);

    // All sessions visible initially.
    expect(getByText("alpha")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
    expect(getByText("gamma redteam")).toBeTruthy();

    // Filter by name substring.
    const input = getByLabelText("Filter sessions by name") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "redteam" } });
    expect(queryByText("alpha")).toBeNull();
    expect(queryByText("beta")).toBeNull();
    expect(getByText("gamma redteam")).toBeTruthy();

    // Filter by workdir substring.
    fireEvent.input(input, { target: { value: "/repo" } });
    expect(getByText("alpha")).toBeTruthy();
    expect(getByText("beta")).toBeTruthy();
    expect(queryByText("gamma redteam")).toBeNull();
  });

  it("shows a no-match hint pointing at Ctrl+K content search", () => {
    ingestSessionList([sess("a", "alpha"), sess("b", "beta")]);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);
    fireEvent.input(getByLabelText("Filter sessions by name"), { target: { value: "zzz-nope" } });
    expect(queryByText("alpha")).toBeNull();
    expect(getByText(/No session name matches/)).toBeTruthy();
    expect(getByText(/search message content/)).toBeTruthy();
  });

  it("the clear button restores the full list", () => {
    ingestSessionList([sess("a", "alpha"), sess("b", "beta")]);
    const { getByLabelText, getByText, queryByText } = render(() => <SessionListPane />);
    const input = getByLabelText("Filter sessions by name") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "alpha" } });
    expect(queryByText("beta")).toBeNull();
    fireEvent.click(getByLabelText("Clear filter"));
    expect(getByText("beta")).toBeTruthy();
  });
});
