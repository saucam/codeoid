/**
 * Slash-command parsing + dispatch. Mirrors the TUI verbs:
 *   /new <name> [workdir]    — create a session (workdir defaults to cwd)
 *   /rename <name>           — rename focused session
 *   /destroy                 — destroy focused session
 *   /interrupt               — interrupt current turn
 *   /rotate                  — rotate context (refresh skills/settings)
 *   /mode <i|a|x>            — interactive | auto-allow | autonomous
 *   /model <id|alias>        — switch model (opus / sonnet / haiku / full id)
 *   /help                    — surface help modal (TODO P6)
 *   /clear                   — clear prompt (handled by caller before dispatch)
 *
 * Pure functions — easy to unit-test. The `dispatch` helper takes a
 * thin context object so we can mock send/newRequestId in tests.
 */

import type {
  ClientMessage,
  SessionMode,
} from "../../protocol/types";

export type SlashCommand =
  | { kind: "new"; name: string; workdir?: string }
  | { kind: "rename"; name: string }
  | { kind: "destroy" }
  | { kind: "interrupt" }
  | { kind: "rotate" }
  | { kind: "mode"; mode: SessionMode; maxTurns?: number }
  | { kind: "model"; model: string; fallback?: string | null }
  | { kind: "help" }
  | { kind: "clear" };

export function parseSlash(raw: string): SlashCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const head = trimmed.slice(1);
  const [verb, ...rest] = head.split(/\s+/);
  if (!verb) return null;

  switch (verb.toLowerCase()) {
    case "new": {
      if (rest.length === 0) {
        throw new Error("/new <name> [workdir]");
      }
      const [name, ...wd] = rest;
      const workdir = wd.length > 0 ? wd.join(" ") : undefined;
      return { kind: "new", name: name!, workdir };
    }
    case "rename": {
      if (rest.length === 0) throw new Error("/rename <name>");
      return { kind: "rename", name: rest.join(" ") };
    }
    case "destroy":
      return { kind: "destroy" };
    case "interrupt":
      return { kind: "interrupt" };
    case "rotate":
      return { kind: "rotate" };
    case "mode": {
      const m = rest[0]?.toLowerCase();
      if (!m) throw new Error("/mode <interactive|auto-allow|autonomous>");
      const mode: SessionMode | undefined =
        m === "i" || m === "interactive"
          ? "interactive"
          : m === "a" || m === "auto-allow" || m === "auto"
            ? "auto-allow"
            : m === "x" || m === "autonomous"
              ? "autonomous"
              : undefined;
      if (!mode) throw new Error(`unknown mode: ${m}`);
      const maxTurnsArg = rest[1];
      const maxTurns = maxTurnsArg ? Number.parseInt(maxTurnsArg, 10) : undefined;
      return {
        kind: "mode",
        mode,
        ...(maxTurns !== undefined && Number.isFinite(maxTurns)
          ? { maxTurns }
          : {}),
      };
    }
    case "model": {
      if (rest.length === 0) throw new Error("/model <id|alias>");
      const [model, fallback] = rest;
      return {
        kind: "model",
        model: model!,
        ...(fallback !== undefined ? { fallback } : {}),
      };
    }
    case "help":
      return { kind: "help" };
    case "clear":
      return { kind: "clear" };
    default:
      throw new Error(`unknown slash command: /${verb}`);
  }
}

export interface SlashContext {
  sessionId: string;
  send: (msg: ClientMessage) => void;
  newRequestId: () => string;
  removeSession: (id: string) => void;
}

export function dispatchSlash(cmd: SlashCommand, ctx: SlashContext): void {
  switch (cmd.kind) {
    case "new":
      ctx.send({
        type: "session.create",
        id: ctx.newRequestId(),
        name: cmd.name,
        workdir: cmd.workdir ?? ".",
      });
      return;
    case "rename":
      ctx.send({
        type: "session.rename",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        name: cmd.name,
      });
      return;
    case "destroy":
      ctx.send({
        type: "session.destroy",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
      });
      // Optimistically drop locally; the daemon's broadcast will confirm.
      ctx.removeSession(ctx.sessionId);
      return;
    case "interrupt":
      ctx.send({
        type: "session.interrupt",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
      });
      return;
    case "rotate":
      ctx.send({
        type: "session.rotate",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
      });
      return;
    case "mode":
      ctx.send({
        type: "session.set_mode",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        mode: cmd.mode,
        ...(cmd.maxTurns !== undefined ? { maxTurns: cmd.maxTurns } : {}),
      });
      return;
    case "model":
      ctx.send({
        type: "session.set_model",
        id: ctx.newRequestId(),
        sessionId: ctx.sessionId,
        model: cmd.model,
        ...(cmd.fallback !== undefined ? { fallbackModel: cmd.fallback } : {}),
      });
      return;
    case "help":
      // Caller surfaces the modal; nothing to send.
      return;
    case "clear":
      // Pure UI side-effect handled by the caller.
      return;
  }
}
