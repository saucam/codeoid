/**
 * The codeoid↔pi bridge extension.
 *
 * pi ships NO built-in permission system — tool gating is explicitly
 * delegated to extensions (see pi-mono README "Permissions &
 * Containerization"). This extension IS codeoid's gate: it hooks pi's
 * `tool_call` event and routes every tool invocation through codeoid's
 * unified approval flow before pi executes it.
 *
 * Transport trick: in `--mode rpc`, pi marshals `ctx.ui.input()` as an
 * `extension_ui_request` frame and blocks the tool until the client answers.
 * codeoid is that client — PiProvider recognises the reserved title
 * `codeoid:tool-approval`, runs the payload through `canUseTool` (the same
 * gate Claude sessions use: modes, budgets, session.approve), and answers
 * with a JSON decision. Real user-extension dialogs (any other title) pass
 * through to codeoid's `session.ui_request` surface untouched.
 *
 * The source is written to a temp file at spawn time and loaded with
 * `pi -e <path>` — plain JS (no TS syntax) so it loads under any pi version
 * without depending on jiti transforms.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Reserved dialog title — the provider treats these as approval requests. */
export const APPROVAL_TITLE = "codeoid:tool-approval";
/** Reserved dialog title — the provider treats these as memory-tool calls: it
 *  runs the referenced recall tool against the daemon's engine and answers with
 *  the verbatim result text. pi has no MCP, so this ctx.ui.input round-trip is
 *  how a pi-registered tool reaches the daemon-side MemoryEngine. */
export const MEMORY_TOOL_TITLE = "codeoid:memory-tool";
/** Status key/value the bridge sets on session_start — the readiness handshake. */
export const BRIDGE_STATUS_KEY = "codeoid";
export const BRIDGE_READY_VALUE = "bridge-ready";

/** The always-present bridge body: readiness handshake + the tool_call approval
 *  gate. Wrapped by {@link buildBridgeSource} with an optional memory-tool block. */
const BRIDGE_BASE_BODY = `  // Readiness handshake: PiProvider fails a turn closed if this status
  // never arrives (a missing gate must not mean "everything runs ungated").
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(${JSON.stringify(BRIDGE_STATUS_KEY)}, ${JSON.stringify(BRIDGE_READY_VALUE)});
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) {
      return { block: true, reason: "codeoid bridge has no UI channel; tool blocked" };
    }
    const payload = JSON.stringify({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
    const raw = await ctx.ui.input(${JSON.stringify(APPROVAL_TITLE)}, payload);
    if (raw === undefined || raw === null || raw === "") {
      return { block: true, reason: "Denied by codeoid (no decision)" };
    }
    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      return { block: true, reason: "Denied by codeoid (malformed decision)" };
    }
    if (!decision || decision.behavior !== "allow") {
      return { block: true, reason: (decision && decision.message) || "Denied by user" };
    }
    if (decision.updatedInput && typeof decision.updatedInput === "object") {
      // pi contract: mutations to event.input feed the actual execution.
      for (const key of Object.keys(decision.updatedInput)) {
        event.input[key] = decision.updatedInput[key];
      }
    }
    return undefined; // allow
  });`;

/**
 * Memory recall tools (Phase 4) — registered only when the session has memory.
 * pi has no MCP, so each tool proxies to the daemon over
 * ctx.ui.input(MEMORY_TOOL_TITLE); PiProvider runs the referenced recall def
 * against the live MemoryEngine and answers with the verbatim result text.
 * Param shapes mirror src/daemon/memory/tools.ts — keep in sync.
 */
const BRIDGE_MEMORY_BLOCK = `
  const codeoidMemTools = [
    ["recall", "Semantic recall across all prior episodes in this workspace (verbatim).", Type.Object({ query: Type.String({ description: "What to recall" }), limit: Type.Optional(Type.Integer()), include_current_session: Type.Optional(Type.Boolean()), tool_name: Type.Optional(Type.String()) })],
    ["recall_file", "The most recent prior read of a specific file.", Type.Object({ path: Type.String({ description: "Absolute or workspace-relative path" }) })],
    ["timeline", "Walk prior activity in order; each line carries an episode_id.", Type.Object({ limit: Type.Optional(Type.Integer()), offset: Type.Optional(Type.Integer()) })],
    ["get_episode", "Fetch one past turn or tool result verbatim by episode_id.", Type.Object({ episode_id: Type.String({ description: "episode_id from recall/timeline output" }) })],
  ];
  for (const [bare, description, parameters] of codeoidMemTools) {
    pi.registerTool({
      name: "codeoid_memory__" + bare,
      label: "Memory: " + bare,
      description,
      parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!ctx.hasUI) return { content: [{ type: "text", text: "codeoid memory unavailable (no UI channel)" }] };
        const answer = await ctx.ui.input(${JSON.stringify(MEMORY_TOOL_TITLE)}, JSON.stringify({ tool: bare, args: params || {} }));
        return { content: [{ type: "text", text: answer == null ? "" : String(answer) }] };
      },
    });
  }`;

/**
 * Build the bridge extension source. With `memoryTools`, prepend the typebox
 * import (spike-verified to resolve in pi's `-e` loader) and register the
 * memory recall tools inside the extension.
 */
export function buildBridgeSource(memoryTools: boolean): string {
  return `${memoryTools ? 'import { Type } from "typebox";\n' : ""}/**
 * codeoid bridge — injected by the codeoid daemon (PiProvider). Do not edit:
 * regenerated on every session spawn.
 */
export default function (pi) {
${BRIDGE_BASE_BODY}
${memoryTools ? BRIDGE_MEMORY_BLOCK : ""}
}
`;
}

/**
 * Write the bridge to a fresh temp dir and return its path. A new file per
 * provider instance keeps concurrent sessions from racing on one path. The
 * memory variant is written as `.mjs` to force ESM (the typebox import).
 */
export function writeBridgeExtension(opts: { memoryTools?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-pi-bridge-"));
  const memoryTools = opts.memoryTools ?? false;
  const path = join(dir, memoryTools ? "codeoid-bridge.mjs" : "codeoid-bridge.js");
  writeFileSync(path, buildBridgeSource(memoryTools), "utf8");
  return path;
}
