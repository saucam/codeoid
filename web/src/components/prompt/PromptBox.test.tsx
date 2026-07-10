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

function sess2(): SessionInfo {
  return { ...sess(), id: "s2", name: "s2" };
}

async function dropFile(container: HTMLElement, name: string): Promise<void> {
  const footer = container.querySelector("footer") ?? container.firstElementChild!;
  const file = new File(["hello attachment"], name, { type: "text/plain" });
  fireEvent.drop(footer, {
    dataTransfer: { types: ["Files"], files: [file] as unknown as FileList },
  });
  // readAttachment resolves file.text() — flush the microtask queue.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("PromptBox attachments are session-scoped", () => {
  it("clears pending attachments when the focused session changes", async () => {
    ingestSessionList([sess(), sess2()]);
    focusSession("s");
    const { container, queryByText, findByText } = render(() => <PromptBox />);

    await dropFile(container as HTMLElement, "secrets.env");
    expect(await findByText("secrets.env")).toBeTruthy();

    // Switching sessions must NOT carry the file along — a send on s2
    // would otherwise deliver s1's dropped file to the wrong agent.
    focusSession("s2");
    await Promise.resolve();
    expect(queryByText("secrets.env")).toBeNull();
  });
});

describe("PromptBox /fork", () => {
  it("routes /fork <backend> to session.fork and focuses the fork", async () => {
    vi.mocked(request).mockResolvedValueOnce({
      id: "fork-1",
      name: "s (fork)",
      workdir: "/tmp",
      status: "idle",
      createdBy: "u",
      createdAt: "2026-05-04T08:00:00Z",
      attachedClients: 0,
    });
    ingestSessionList([sess()]);
    focusSession("s");
    const r = render(() => <PromptBox />);
    const ta = r.container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.input(ta, { target: { value: "/fork codex" } });
    fireEvent.keyDown(ta, { key: "Enter" });

    // The historical bug: /fork opened the import-bundle dialog and
    // silently dropped the backend argument. It must send session.fork.
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.fork",
        sessionId: "s",
        providerId: "codex",
      }),
    );
    // …and once the daemon answers, the fork becomes the focused session.
    await Promise.resolve();
    await Promise.resolve();
    const { focusedSessionId } = await import("../../state/sessions");
    expect(focusedSessionId()).toBe("fork-1");
  });
});
