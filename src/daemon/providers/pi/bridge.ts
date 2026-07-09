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
/** Status key/value the bridge sets on session_start — the readiness handshake. */
export const BRIDGE_STATUS_KEY = "codeoid";
export const BRIDGE_READY_VALUE = "bridge-ready";

export const BRIDGE_EXTENSION_SOURCE = `/**
 * codeoid bridge — injected by the codeoid daemon (PiProvider). Do not edit:
 * regenerated on every session spawn.
 */
export default function (pi) {
  // Readiness handshake: PiProvider fails a turn closed if this status
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
  });
}
`;

/**
 * Write the bridge to a fresh temp dir and return its path. A new file per
 * provider instance keeps concurrent sessions from racing on one path.
 */
export function writeBridgeExtension(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeoid-pi-bridge-"));
  const path = join(dir, "codeoid-bridge.js");
  writeFileSync(path, BRIDGE_EXTENSION_SOURCE, "utf8");
  return path;
}
