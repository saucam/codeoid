// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
const clientState = vi.hoisted(() => ({ available: true }));
vi.mock("./connection", () => ({
  send: vi.fn(),
  request: vi.fn(() => Promise.resolve(undefined)),
  newRequestId: () => "r",
  getClient: () => {
    if (!clientState.available) throw new Error("not bootstrapped");
    return { request: clientRequestMock };
  },
}));

import {
  ensureCommands,
  invalidateCommands,
  isProviderCommand,
  providerCommands,
  _resetCommandsForTest,
} from "./commands";

afterEach(() => {
  _resetCommandsForTest();
  clientRequestMock.mockReset();
  clientState.available = true;
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("commands store", () => {
  it("fetches once and caches the catalog", async () => {
    clientRequestMock.mockResolvedValue({
      type: "session.commands.result",
      requestId: "r",
      sessionId: "s",
      providerId: "pi",
      commands: [{ name: "review", source: "extension" }],
    });
    ensureCommands("s");
    ensureCommands("s"); // in-flight — must not double-fetch
    await flush();
    ensureCommands("s"); // cached — must not re-fetch
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
    expect(providerCommands("s")).toEqual([{ name: "review", source: "extension" }]);
  });

  it("isProviderCommand matches case-insensitively, only for the session", async () => {
    clientRequestMock.mockResolvedValue({
      type: "session.commands.result",
      requestId: "r",
      sessionId: "s",
      providerId: "pi",
      commands: [{ name: "Fix-Tests" }],
    });
    ensureCommands("s");
    await flush();
    expect(isProviderCommand("s", "fix-tests")).toBe(true);
    expect(isProviderCommand("s", "FIX-TESTS")).toBe(true);
    expect(isProviderCommand("s", "other")).toBe(false);
    expect(isProviderCommand("other-session", "fix-tests")).toBe(false);
    expect(isProviderCommand(null, "fix-tests")).toBe(false);
  });

  it("caches [] on daemon rejection so older daemons aren't hammered", async () => {
    clientRequestMock.mockRejectedValue(new Error("Unknown message type"));
    ensureCommands("s");
    await flush();
    expect(providerCommands("s")).toEqual([]);
    ensureCommands("s");
    expect(clientRequestMock).toHaveBeenCalledTimes(1);
  });

  it("invalidateCommands forces a refetch", async () => {
    clientRequestMock.mockResolvedValue({
      type: "session.commands.result",
      requestId: "r",
      sessionId: "s",
      providerId: "pi",
      commands: [],
    });
    ensureCommands("s");
    await flush();
    invalidateCommands("s");
    ensureCommands("s");
    await flush();
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
  });

  it("is a no-op before the client is bootstrapped (retries later)", async () => {
    clientState.available = false;
    ensureCommands("s");
    await flush();
    expect(providerCommands("s")).toEqual([]);
    // Once the client exists, the same session fetches.
    clientState.available = true;
    clientRequestMock.mockResolvedValue({
      type: "session.commands.result",
      requestId: "r",
      sessionId: "s",
      providerId: "pi",
      commands: [{ name: "review" }],
    });
    ensureCommands("s");
    await flush();
    expect(providerCommands("s")).toEqual([{ name: "review" }]);
  });
});
