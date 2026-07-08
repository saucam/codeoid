// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../state/connection", () => ({ send: vi.fn(), newRequestId: () => "r" }));
vi.mock("../state/models", () => ({ fetchModels: vi.fn(), modelCatalog: () => [] }));
vi.mock("./SessionExportModal", () => ({ openExportModal: vi.fn() }));

import SessionControls from "./SessionControls";
import {
  ingestSessionList,
  focusSession,
  _resetSessionsForTest,
} from "../state/sessions";
import type { SessionInfo } from "../protocol/types";

function sess(): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
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
