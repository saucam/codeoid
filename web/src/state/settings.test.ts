// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";

const clientRequestMock = vi.hoisted(() => vi.fn());
vi.mock("./connection", () => ({
  newRequestId: () => "r",
  getClient: () => ({ request: clientRequestMock }),
}));

import {
  fetchSettings,
  saveSettings,
  settingsState,
  _resetSettingsForTest,
} from "./settings";

afterEach(() => {
  _resetSettingsForTest();
  clientRequestMock.mockReset();
});

const MANIFEST = {
  version: 1,
  tabs: [
    {
      id: "general",
      title: "General",
      groups: [
        {
          id: "session",
          title: "Session",
          fields: [
            { key: "memory.enabled", label: "Memory", help: "", kind: "boolean", backing: "config", path: "memory.enabled", applies: "restart" },
          ],
        },
      ],
    },
  ],
};

const SNAPSHOT = {
  values: { "memory.enabled": { value: true, source: "default" } },
  secrets: { OPENAI_API_KEY: { set: false, source: "unset" } },
  configPath: "/home/u/.codeoid/config.json",
  envPath: "/home/u/.codeoid/.env",
};

describe("settings store", () => {
  it("fetches the manifest + snapshot and caches them", async () => {
    clientRequestMock
      .mockResolvedValueOnce({ type: "settings.schema.result", requestId: "r", manifest: MANIFEST })
      .mockResolvedValueOnce({ type: "settings.get.result", requestId: "r", snapshot: SNAPSHOT });

    await fetchSettings();
    expect(settingsState().manifest?.tabs).toHaveLength(1);
    expect(settingsState().snapshot?.values["memory.enabled"]?.value).toBe(true);
    expect(clientRequestMock).toHaveBeenCalledTimes(2);

    // Cached — no further round trips without force.
    await fetchSettings();
    expect(clientRequestMock).toHaveBeenCalledTimes(2);
  });

  it("records an error when a fetch fails", async () => {
    clientRequestMock.mockRejectedValueOnce(new Error("nope"));
    await fetchSettings();
    expect(settingsState().error).toBe("nope");
    expect(settingsState().manifest).toBeNull();
  });

  it("saveSettings applies the returned snapshot + tracks restartRequired", async () => {
    clientRequestMock.mockResolvedValueOnce({
      type: "settings.set.result",
      requestId: "r",
      ok: true,
      snapshot: { ...SNAPSHOT, values: { "memory.enabled": { value: false, source: "config" } } },
      errors: [],
      restartRequired: true,
    });

    const res = await saveSettings([{ key: "memory.enabled", value: false }]);
    expect(res?.ok).toBe(true);
    expect(settingsState().snapshot?.values["memory.enabled"]?.value).toBe(false);
    expect(settingsState().restartRequired).toBe(true);
  });

  it("saveSettings surfaces per-field errors and does not flip restartRequired", async () => {
    clientRequestMock.mockResolvedValueOnce({
      type: "settings.set.result",
      requestId: "r",
      ok: false,
      snapshot: SNAPSHOT,
      errors: [{ key: "autoRotate.warnPct", message: "out of range" }],
      restartRequired: false,
    });

    const res = await saveSettings([{ key: "autoRotate.warnPct", value: 5 }]);
    expect(res?.ok).toBe(false);
    expect(settingsState().saveErrors[0]?.key).toBe("autoRotate.warnPct");
    expect(settingsState().restartRequired).toBe(false);
  });

  it("saveSettings is a no-op for an empty patch set", async () => {
    const res = await saveSettings([]);
    expect(res).toBeNull();
    expect(clientRequestMock).not.toHaveBeenCalled();
  });
});
