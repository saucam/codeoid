/**
 * Model-A native mount (S4): registry specs → the claude SDK's McpServerConfig
 * shape, with `${VAR}` env + bearer resolved against the daemon env, built-in
 * memory excluded, and per-backend filtering honored.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registryServersForClaude } from "../daemon/providers/claude/index.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import type { RawMcpServerConfig } from "../config.js";

function raw(p: Partial<RawMcpServerConfig>): RawMcpServerConfig {
  return { args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p } as RawMcpServerConfig;
}

describe("registryServersForClaude", () => {
  const prev = process.env.GH_PAT;
  beforeEach(() => {
    process.env.GH_PAT = "tok-123";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.GH_PAT;
    else process.env.GH_PAT = prev;
  });

  it("maps a stdio spec and resolves ${VAR} env refs; excludes built-in memory", () => {
    const reg = new McpRegistry(
      { github: raw({ command: "npx", args: ["-y", "@mcp/github"], env: { TOKEN: "${GH_PAT}" } }) },
      { memoryEnabled: true },
    );
    const servers = registryServersForClaude(reg);
    expect(servers.github).toEqual({ command: "npx", args: ["-y", "@mcp/github"], env: { TOKEN: "tok-123" } } as unknown as typeof servers.github);
    expect("codeoid_memory" in servers).toBe(false); // built-in → its own path
  });

  it("maps an http spec and injects the bearer from its env var", () => {
    const reg = new McpRegistry(
      { linear: raw({ url: "https://mcp.linear.app/mcp", bearerTokenEnv: "GH_PAT" }) },
      { memoryEnabled: false },
    );
    const servers = registryServersForClaude(reg);
    expect(servers.linear).toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer tok-123" } } as unknown as typeof servers.linear);
  });

  it("honors the backends allowlist and returns {} for no registry", () => {
    const reg = new McpRegistry({ other: raw({ command: "x", backends: ["codex"] }) }, { memoryEnabled: false });
    expect(registryServersForClaude(reg)).toEqual({}); // not for claude
    expect(registryServersForClaude(undefined)).toEqual({});
  });
});
