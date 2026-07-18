/**
 * SessionMcpTools + tool-loop external-MCP wiring (S3). Exercises the shared
 * per-(session,backend) view and the openai/gemini declaration + execution
 * helpers end-to-end through a real McpHub + the fake-mcp-stdio fixture — the
 * same path the in-daemon backends use, without needing a model SDK.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { McpHub } from "../daemon/mcp/hub.js";
import { McpRegistry } from "../daemon/mcp/registry.js";
import { SessionMcpTools } from "../daemon/mcp/tool-source.js";
import {
  executeMcpToolCall,
  mcpToolsAsGemini,
  mcpToolsAsOpenAI,
} from "../daemon/providers/tool-loop.js";
import type { ProviderEvent } from "../daemon/providers/interface.js";
import type { RawMcpServerConfig } from "../config.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-stdio.ts");
const DAEMON_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };
const SCOPE = { workspaceId: "w", sessionId: "s" };

function raw(p: Partial<RawMcpServerConfig>): RawMcpServerConfig {
  return { args: [], env: {}, headers: {}, trust: "prompt", scope: "session", enabled: true, native: false, ...p } as RawMcpServerConfig;
}

function toolsFor(backend: string, servers: Record<string, RawMcpServerConfig>): { tools: SessionMcpTools; hub: McpHub } {
  const reg = new McpRegistry(servers, { memoryEnabled: true }); // memory present but built-in → excluded
  const hub = new McpHub({ daemonEnv: DAEMON_ENV });
  return { tools: new SessionMcpTools(reg, hub, backend, SCOPE), hub };
}

describe("SessionMcpTools", () => {
  it("discovers external server tools under canonical names, excluding built-in memory", async () => {
    const { tools, hub } = toolsFor("openai", { local: raw({ command: process.execPath, args: [FIXTURE] }) });
    expect(tools.hasServers()).toBe(true);
    const handles = await tools.handles();
    expect(handles.map((h) => h.canonicalName).sort()).toEqual(["mcp__local__boom", "mcp__local__echo"]);
    // codeoid_memory is built-in → NOT surfaced here (it has its own paths).
    expect(handles.some((h) => h.server === "codeoid_memory")).toBe(false);
    hub.closeAll();
  });

  it("routes a call to the right server through the hub with scope", async () => {
    const { tools, hub } = toolsFor("openai", { local: raw({ command: process.execPath, args: [FIXTURE] }) });
    expect(tools.owns("mcp__local__echo")).toBe(true);
    expect(tools.owns("mcp__other__x")).toBe(false);
    const res = await tools.call("mcp__local__echo", { msg: "hi" });
    expect(res.isError).toBe(false);
    expect(res.text).toBe('echo:{"msg":"hi"}');
    hub.closeAll();
  });

  it("routes to the longest matching server name on prefix overlap", async () => {
    const reg = new McpRegistry(
      { local: raw({ command: process.execPath, args: [FIXTURE] }), local__x: raw({ command: process.execPath, args: [FIXTURE] }) },
      { memoryEnabled: false },
    );
    const hub = new McpHub({ daemonEnv: DAEMON_ENV });
    const tools = new SessionMcpTools(reg, hub, "openai", SCOPE);
    // Must route to server "local__x" (tool "echo"), NOT "local" (tool "x__echo").
    const res = await tools.call("mcp__local__x__echo", { msg: "hi" });
    expect(res.isError).toBe(false);
    expect(res.text).toBe('echo:{"msg":"hi"}');
    hub.closeAll();
  });

  it("honors the per-backend allowlist (backends field)", () => {
    const { tools, hub } = toolsFor("openai", { local: raw({ command: "x", backends: ["claude"] }) });
    expect(tools.hasServers()).toBe(false); // not for openai
    hub.closeAll();
  });

  it("carries trust through to the handle", async () => {
    const { tools, hub } = toolsFor("gemini", { local: raw({ command: process.execPath, args: [FIXTURE], trust: "readonly" }) });
    const handles = await tools.handles();
    expect(handles.every((h) => h.trust === "readonly")).toBe(true);
    hub.closeAll();
  });
});

describe("tool-loop external-MCP declarations", () => {
  it("mcpToolsAsOpenAI maps handles to canonical function tools", async () => {
    const { tools, hub } = toolsFor("openai", { local: raw({ command: process.execPath, args: [FIXTURE] }) });
    const decls = mcpToolsAsOpenAI(await tools.handles());
    const echo = decls.find((d) => d.function.name === "mcp__local__echo");
    expect(echo).toBeDefined();
    expect(echo?.type).toBe("function");
    expect((echo?.function.parameters as { type?: string }).type).toBe("object");
    hub.closeAll();
  });

  it("mcpToolsAsGemini strips additionalProperties", () => {
    const decls = mcpToolsAsGemini([
      { server: "s", tool: "t", canonicalName: "mcp__s__t", description: "d", inputSchema: { type: "object", additionalProperties: false, properties: {} }, trust: "prompt" },
    ]);
    expect(decls[0]!.name).toBe("mcp__s__t");
    expect("additionalProperties" in (decls[0]!.parameters as object)).toBe(false);
  });
});

describe("executeMcpToolCall", () => {
  it("gates through canUseTool, runs on allow, emits tool_start/complete", async () => {
    const { tools, hub } = toolsFor("openai", { local: raw({ command: process.execPath, args: [FIXTURE] }) });
    const events: ProviderEvent[] = [];
    const out = await executeMcpToolCall(
      "mcp__local__echo",
      { msg: "yo" },
      { tools, canUseTool: async () => ({ behavior: "allow" }), emit: (e) => events.push(e) },
    );
    expect(out).toBe('echo:{"msg":"yo"}');
    expect(events.find((e) => e.type === "tool_start")).toBeDefined();
    const done = events.find((e) => e.type === "tool_complete");
    expect(done && (done as { success: boolean }).success).toBe(true);
    hub.closeAll();
  });

  it("returns the denial and does NOT run the tool when denied", async () => {
    const { tools, hub } = toolsFor("openai", { local: raw({ command: process.execPath, args: [FIXTURE] }) });
    const events: ProviderEvent[] = [];
    const out = await executeMcpToolCall(
      "mcp__local__echo",
      { msg: "no" },
      { tools, canUseTool: async () => ({ behavior: "deny", message: "nope" }), emit: (e) => events.push(e) },
    );
    expect(out).toBe("nope");
    const done = events.find((e) => e.type === "tool_complete");
    expect(done && (done as { success: boolean }).success).toBe(false);
    hub.closeAll();
  });
});
