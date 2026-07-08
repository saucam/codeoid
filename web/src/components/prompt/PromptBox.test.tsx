// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../../state/connection", () => ({
  request: vi.fn(() => Promise.resolve({})),
  send: vi.fn(),
  newRequestId: () => "r",
}));

import PromptBox from "./PromptBox";
import { request } from "../../state/connection";
import {
  ingestSessionList,
  focusSession,
  _resetSessionsForTest,
} from "../../state/sessions";
import { _resetDraftsForTest } from "../../state/prompt-drafts";
import type { SessionInfo } from "../../protocol/types";

function sess(): SessionInfo {
  return {
    id: "s",
    name: "s",
    workdir: "/tmp",
    status: "idle",
    createdBy: "u",
    createdAt: "2026-05-04T08:00:00Z",
    attachedClients: 0,
  } as SessionInfo;
}

afterEach(() => {
  cleanup();
  _resetSessionsForTest();
  _resetDraftsForTest();
  vi.mocked(request).mockClear();
});

function setup() {
  ingestSessionList([sess()]);
  focusSession("s");
  const r = render(() => <PromptBox />);
  const ta = r.container.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.input(ta, { target: { value: "hello" } });
  return { ...r, ta };
}

describe("PromptBox IME guard", () => {
  it("does NOT submit on Enter while an IME composition is active", () => {
    const { ta } = setup();
    // keyCode 229 is the IME-composition signal the guard also checks, for
    // browsers/jsdom that don't surface isComposing on the confirming keydown.
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(request).not.toHaveBeenCalled();
  });

  it("submits on a real Enter (composition finished)", () => {
    const { ta } = setup();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.send", text: "hello" }),
    );
  });
});
