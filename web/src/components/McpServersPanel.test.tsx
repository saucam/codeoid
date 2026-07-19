// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { McpServersPanel } from "./SettingsDrawer";
import type { McpServerStatus } from "../protocol/types";

afterEach(cleanup);

function server(p: Partial<McpServerStatus> & Pick<McpServerStatus, "name">): McpServerStatus {
  return {
    transport: "stdio",
    trust: "prompt",
    scope: "workspace",
    backends: null,
    enabled: true,
    builtin: false,
    health: "idle",
    toolCount: 0,
    tools: [],
    ...p,
  };
}

describe("McpServersPanel", () => {
  it("renders each server with health, transport, and tool chips", () => {
    const { getByText, container } = render(() => (
      <McpServersPanel
        servers={[
          server({ name: "codeoid_memory", transport: "in-process", trust: "readonly", builtin: true, health: "connected", toolCount: 2, tools: ["recall", "get_episode"] }),
          server({ name: "github", health: "error", error: "spawn npx ENOENT", toolCount: 0 }),
        ]}
      />
    ));
    // Server names shown.
    expect(getByText("codeoid_memory")).toBeTruthy();
    expect(getByText("github")).toBeTruthy();
    // Health labels rendered.
    expect(getByText("connected")).toBeTruthy();
    expect(getByText("error")).toBeTruthy();
    // Built-in badge + error text + tool chips.
    expect(getByText("built-in")).toBeTruthy();
    expect(getByText("spawn npx ENOENT")).toBeTruthy();
    expect(getByText("recall")).toBeTruthy();
    expect(getByText("get_episode")).toBeTruthy();
    // Transport/trust summary present somewhere.
    expect(container.textContent).toContain("in-process");
  });

  it("shows the empty state when no servers are configured", () => {
    const { getByText } = render(() => <McpServersPanel servers={[]} />);
    expect(getByText("No MCP servers configured.")).toBeTruthy();
  });
});
