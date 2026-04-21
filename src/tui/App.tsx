/**
 * App — root TUI component. Orchestrates the WS client, keyboard handling,
 * modals, and layout. Held deliberately flat: there's no router, no pages —
 * just one cockpit view plus optional modal overlays.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useTuiStore } from "./store.js";
import { TuiWsClient } from "./ws.js";
import { SessionTabs } from "./components/SessionTabs.js";
import { MessageRow } from "./components/MessageRow.js";
import { Prompt } from "./components/Prompt.js";
import { StatusBar } from "./components/StatusBar.js";
import { Modal } from "./components/Modal.js";
import { WorkingIndicator } from "./components/WorkingIndicator.js";
import { filterCommands } from "./components/SlashHint.js";
import { fuzzyMatch, scanWorkspaceFiles } from "./file-scanner.js";
import {
  expandWorkspaceCommand,
  loadWorkspaceCommands,
  type WorkspaceCommand,
} from "./workspace-commands.js";
import type { Attachment } from "../protocol/types.js";
import type { CodeoidConfig } from "../config.js";

interface Props {
  config: CodeoidConfig;
}

export function App({ config }: Props) {
  const { state, dispatch } = useTuiStore();
  const { exit } = useApp();
  const { stdout } = useStdout();
  const wsRef = useRef<TuiWsClient | null>(null);

  // Initialize WS client once.
  useEffect(() => {
    const client = new TuiWsClient(config, dispatch);
    wsRef.current = client;
    void client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-attach to all sessions so unread counters and status changes flow
  // even when the user isn't actively viewing that session.
  const attachedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const client = wsRef.current;
    if (!client || state.connection !== "connected") return;
    for (const id of state.order) {
      if (attachedRef.current.has(id)) continue;
      attachedRef.current.add(id);
      void client.attachSession(id).catch(() => {
        attachedRef.current.delete(id);
      });
    }
  }, [state.order, state.connection]);

  const focusedSession = state.focused ? state.sessions.get(state.focused) ?? null : null;
  const orderedSessions = useMemo(
    () =>
      state.order
        .map((id) => state.sessions.get(id))
        .filter((s): s is NonNullable<typeof s> => s !== undefined),
    [state.order, state.sessions],
  );

  // ── Per-session "working since" tracking for the continuous indicator ──

  const workingSinceRef = useRef<Map<string, number>>(new Map());
  const [workingSinceTick, setWorkingSinceTick] = useState(0);
  useEffect(() => {
    // Compare the focused session's status to what we have recorded.
    const fs = focusedSession;
    if (!fs) return;
    const sessionId = fs.info.id;
    const status = fs.info.status;
    const current = workingSinceRef.current.get(sessionId) ?? null;
    if (status === "working") {
      if (current === null) {
        workingSinceRef.current.set(sessionId, Date.now());
        setWorkingSinceTick((t) => t + 1);
      }
    } else {
      if (current !== null) {
        workingSinceRef.current.delete(sessionId);
        setWorkingSinceTick((t) => t + 1);
      }
    }
  }, [focusedSession?.info.id, focusedSession?.info.status]);
  const workingSince =
    focusedSession && focusedSession.info.status === "working"
      ? (workingSinceRef.current.get(focusedSession.info.id) ?? Date.now())
      : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  void workingSinceTick;

  // ── Slash + workspace-command selection state (UI-only) ───────────────

  const [slashIdx, setSlashIdx] = useState(0);
  const [workspaceCommands, setWorkspaceCommands] = useState<WorkspaceCommand[]>(
    [],
  );
  // Reload workspace commands when the focused session's workdir changes.
  useEffect(() => {
    if (focusedSession) {
      try {
        setWorkspaceCommands(loadWorkspaceCommands(focusedSession.info.workdir));
      } catch {
        setWorkspaceCommands([]);
      }
    } else {
      setWorkspaceCommands([]);
    }
  }, [focusedSession?.info.workdir]);

  const slashMatches = useMemo(() => {
    if (state.modal) return [];
    if (!state.input.startsWith("/") || state.input.includes("\n")) return [];
    const builtins = filterCommands(state.input);
    const prefix = state.input.split(/\s/)[0]!.toLowerCase();
    const workspace = workspaceCommands
      .filter((c) => c.name.startsWith(prefix))
      .map((c) => ({ name: c.name, description: c.description }));
    return [...builtins, ...workspace];
  }, [state.input, state.modal, workspaceCommands]);
  const inSlashMode =
    !state.modal &&
    state.input.startsWith("/") &&
    !state.input.includes("\n") &&
    slashMatches.length > 0;

  useEffect(() => {
    if (slashIdx >= slashMatches.length) setSlashIdx(0);
  }, [slashMatches.length, slashIdx]);

  // ── @file mention state ───────────────────────────────────────────────

  const mention = useMemo(
    () => detectMention(state.input, state.cursor),
    [state.input, state.cursor],
  );
  const workspaceFiles = useMemo(
    () =>
      focusedSession ? scanWorkspaceFiles(focusedSession.info.workdir) : [],
    [focusedSession?.info.workdir],
  );
  const mentionMatches = useMemo(
    () => (mention ? fuzzyMatch(workspaceFiles, mention.query, 10) : []),
    [mention, workspaceFiles],
  );
  const [mentionIdx, setMentionIdx] = useState(0);
  useEffect(() => {
    if (mentionIdx >= mentionMatches.length) setMentionIdx(0);
  }, [mentionMatches.length, mentionIdx]);

  const inMentionMode = !state.modal && !inSlashMode && mention !== null;

  // ── Keyboard handling ──────────────────────────────────────────────────

  useInput(
    (input, key) => {
      if (state.modal) return;

      // Approval hotkeys — only when input is empty so we don't steal y/n from typing.
      if (
        focusedSession?.pendingApproval &&
        state.input.length === 0 &&
        (input === "y" || input === "Y" || input === "n" || input === "N")
      ) {
        const approved = input === "y" || input === "Y";
        const approvalId = focusedSession.pendingApproval.approvalId;
        const sessionId = focusedSession.info.id;
        void wsRef.current?.approve(sessionId, approvalId, approved).catch(() => {});
        dispatch({ type: "approval.clear", sessionId });
        return;
      }

      // Mention-mode navigation — takes priority over slash because the
      // mention overlay only appears when slash-mode doesn't match.
      if (inMentionMode && mention) {
        if (key.upArrow) {
          setMentionIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setMentionIdx((i) =>
            Math.min(mentionMatches.length - 1, i + 1),
          );
          return;
        }
        if (key.tab || (key.return && mentionMatches.length > 0)) {
          const picked = mentionMatches[mentionIdx];
          if (picked) {
            const before = state.input.slice(0, mention.start);
            const after = state.input.slice(mention.start + mention.query.length + 1);
            const replacement = `@${picked}`;
            const next = before + replacement + after;
            dispatch({ type: "input.set", value: next });
            dispatch({ type: "cursor.set", position: before.length + replacement.length });
          }
          return;
        }
        if (key.escape) {
          // Strip the partial mention so overlay closes.
          const before = state.input.slice(0, mention.start);
          const after = state.input.slice(mention.start + mention.query.length + 1);
          dispatch({ type: "input.set", value: before + after });
          dispatch({ type: "cursor.set", position: before.length });
          return;
        }
      }

      // Slash-mode navigation.
      if (inSlashMode) {
        if (key.upArrow) {
          setSlashIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSlashIdx((i) => Math.min(slashMatches.length - 1, i + 1));
          return;
        }
        if (key.tab) {
          const picked = slashMatches[slashIdx];
          if (picked) dispatch({ type: "input.set", value: picked.name });
          return;
        }
        if (key.escape) {
          dispatch({ type: "input.clear" });
          return;
        }
      }

      if (key.ctrl && input === "n") {
        dispatch({ type: "modal.open", modal: { kind: "new-session" } });
        return;
      }
      if (key.ctrl && input === "g") {
        dispatch({ type: "modal.open", modal: { kind: "switch-session", query: "" } });
        return;
      }
      if (key.ctrl && input === "d" && focusedSession) {
        dispatch({
          type: "modal.open",
          modal: { kind: "confirm-destroy", sessionId: focusedSession.info.id },
        });
        return;
      }
      if (key.ctrl && input === "f") {
        dispatch({ type: "modal.open", modal: { kind: "search", query: "" } });
        return;
      }
      if (key.ctrl && input === "x" && focusedSession) {
        void wsRef.current?.interrupt(focusedSession.info.id).catch(() => {});
        return;
      }
      // Esc semantics (when NO overlay is open — those branches above):
      //   - input non-empty → clear input (natural "cancel this draft")
      //   - input empty + session working → interrupt (shortcut for Ctrl-X)
      //   - input empty + session idle → no-op
      if (key.escape && focusedSession) {
        if (state.input.length > 0) {
          dispatch({ type: "input.clear" });
          return;
        }
        if (focusedSession.info.status === "working") {
          void wsRef.current?.interrupt(focusedSession.info.id).catch(() => {});
          return;
        }
      }
      if (input === "?" && state.input.length === 0) {
        dispatch({ type: "modal.open", modal: { kind: "help" } });
        return;
      }
      // Shift+Tab cycles the focused session's execution mode. Many
      // terminals don't emit a distinct "shift+tab" — fall back to Ctrl+M.
      if (focusedSession && ((key.shift && key.tab) || (key.ctrl && input === "m"))) {
        cycleFocusedMode();
        return;
      }
    },
    { isActive: !state.modal },
  );

  const cycleFocusedMode = (budgetOverride?: number) => {
    const client = wsRef.current;
    if (!client || !focusedSession) return;
    const current = focusedSession.info.mode ?? "interactive";
    const next: import("../protocol/types.js").SessionMode =
      current === "interactive"
        ? "auto-allow"
        : current === "auto-allow"
          ? "autonomous"
          : "interactive";
    // Autonomous budget: explicit override, otherwise default 50 write/exec actions.
    // "0" = unbounded; undefined outside autonomous.
    const maxTurns =
      next === "autonomous" ? (budgetOverride ?? 50) : undefined;
    void client
      .setMode(
        focusedSession.info.id,
        next,
        maxTurns === 0 ? undefined : maxTurns,
      )
      .catch((err: Error) => {
        dispatch({ type: "error", message: err.message });
      });
  };

  /** Handle `/mode <target> [budget]` — sets a specific mode rather than cycling. */
  const setSpecificMode = (target: string, budgetStr?: string) => {
    const client = wsRef.current;
    if (!client || !focusedSession) return;
    const modes: ReadonlyArray<import("../protocol/types.js").SessionMode> = [
      "interactive",
      "auto-allow",
      "autonomous",
    ];
    if (!modes.includes(target as import("../protocol/types.js").SessionMode)) {
      dispatch({
        type: "error",
        message: `unknown mode: ${target} (expected interactive | auto-allow | autonomous)`,
      });
      return;
    }
    const budget = budgetStr ? Number.parseInt(budgetStr, 10) : undefined;
    const maxTurns =
      target === "autonomous"
        ? budget === 0 || Number.isNaN(budget ?? NaN)
          ? undefined
          : budget
        : undefined;
    void client
      .setMode(
        focusedSession.info.id,
        target as import("../protocol/types.js").SessionMode,
        maxTurns,
      )
      .catch((err: Error) => {
        dispatch({ type: "error", message: err.message });
      });
  };

  // Ctrl-C exit — separate useInput so it works even when modal is open.
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") exit();
  });

  // ── Prompt submit ──────────────────────────────────────────────────────

  const onSubmitPrompt = () => {
    const client = wsRef.current;
    const text = state.input.trim();
    if (!client || !text) return;

    // Slash command path.
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();
      const args = parts.slice(1);
      dispatch({ type: "history.push", entry: text });
      dispatch({ type: "input.clear" });
      handleSlashCommand(cmd, args, text);
      return;
    }

    if (!focusedSession) return;
    const attachments = extractMentionAttachments(text);
    void client
      .send(focusedSession.info.id, text, attachments.length > 0 ? attachments : undefined)
      .catch((err: Error) => {
        dispatch({ type: "error", message: err.message });
      });
    dispatch({ type: "history.push", entry: text });
    dispatch({ type: "input.clear" });
  };

  /**
   * Render a detailed context-budget breakdown as a local scrollback
   * info message — mirrors what Claude Code's `/context` does so users
   * can compare the exact numbers against VSCode/CLI reports.
   *
   * We show every field the SDK's `result.usage` gives us (new input,
   * cache read, cache write) plus derived totals + occupancy. Also makes
   * explicit what ISN'T visible to us (reserved-for-output budget,
   * Claude Code's internal microcompaction) so users know why
   * codeoid's ctx can look lower than a competitor's "used" readout.
   */
  const printContextBreakdownMessage = (session: import("./types.js").TuiSession) => {
    const info = session.info;
    const u = info.usage;
    const W = 1_000_000;

    const lines: string[] = [];
    lines.push(`## Context breakdown for ${info.name}`);
    lines.push("");
    if (!u || u.numTurns === 0) {
      lines.push("No turns completed yet — ctx will populate after Claude's first reply.");
      dispatch({
        type: "session.message",
        sessionId: info.id,
        message: {
          type: "session.message",
          sessionId: info.id,
          messageId: `local:context:${Date.now()}`,
          role: "assistant",
          content: lines.join("\n"),
          identity: { sub: "system:codeoid", name: "codeoid", type: "system" },
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    const mostRecent = u.recentTurns?.[0];
    const lastTotal = u.lastTurnInputTokens ?? 0;
    // Cap displayed ratios at 100%. Raw numbers can exceed when a turn
    // aggregates multiple API calls (subagents / retries), but the
    // per-turn percentage only makes sense bounded to [0, 100].
    const pct = (n: number) => (Math.min(n / W, 1) * 100).toFixed(1) + "%";
    const rawPct = (n: number) => ((n / W) * 100).toFixed(1) + "%";

    lines.push(`### Last turn (raw SDK usage)`);
    if (mostRecent) {
      lines.push(`- new input (uncached): **${formatK(mostRecent.inputTokens)}** (${pct(mostRecent.inputTokens)})`);
      lines.push(`- cache read:           **${formatK(mostRecent.cacheReadTokens)}** (${pct(mostRecent.cacheReadTokens)}) — billed ~10%`);
      lines.push(`- cache creation:       **${formatK(mostRecent.cacheCreationTokens)}** (${pct(mostRecent.cacheCreationTokens)}) — billed ~125%`);
      lines.push(`- output:               **${formatK(mostRecent.outputTokens)}**`);
      lines.push(`- **sum processed this turn: ${formatK(lastTotal)} / ${formatK(W)} = ${pct(lastTotal)}**`);
      lines.push(`- cost: $${mostRecent.totalCostUsd.toFixed(4)} · duration ${(mostRecent.durationMs / 1000).toFixed(1)}s`);
    }
    lines.push("");
    lines.push(`### Session aggregate (${u.numTurns} turns)`);
    lines.push(`- cumulative input (all kinds): ${formatK(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens)}`);
    lines.push(`- cumulative output: ${formatK(u.outputTokens)}`);
    const cacheRate = Math.round(((u.cacheReadTokens) / Math.max(1, u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens)) * 100);
    lines.push(`- cache hit rate (all turns): ${cacheRate}%`);
    const avgCacheRead = u.numTurns > 0 ? Math.round(u.cacheReadTokens / u.numTurns) : 0;
    lines.push(`- **avg cache_read per turn: ${formatK(avgCacheRead)} (${pct(avgCacheRead)}) — the honest "typical primary context size" signal**`);
    const peak = u.peakInputTokens ?? 0;
    const peakOverflow = peak > W;
    lines.push(`- peak single-turn sum: ${formatK(peak)} (${peakOverflow ? rawPct(peak) + " — ⚠ aggregated multi-call, see note below" : pct(peak)})`);
    lines.push(`- total cost: $${u.totalCostUsd.toFixed(4)}`);
    if (info.rotation && info.rotation.count > 0) {
      lines.push(`- 🔄 rotations: ${info.rotation.count}`);
    }
    lines.push("");
    lines.push(`### ⚠ Important: "sum processed this turn" ≠ "context size"`);
    lines.push(`The SDK reports ONE \`usage\` object per turn, but a turn can include multiple internal API calls:`);
    lines.push(`- The primary agent's reply`);
    lines.push(`- Subagent(s) spawned via the Task / Agent tool (each has its OWN context window)`);
    lines.push(`- Retries on rate-limit / capacity errors`);
    lines.push("");
    lines.push(`The SDK **sums** these usages. A subagent-heavy turn can report 1M+ tokens processed even though no single API call exceeded 300k. The hard 1M context window applies PER API CALL, not per turn.`);
    lines.push("");
    lines.push(`**Better signal for "how full is my primary context":** look at \`avg cache_read per turn\` above. The stable prompt prefix (system + tools + CLAUDE.md + conversation history) is what gets cached and re-read every turn. In your session that averages **${formatK(avgCacheRead)} (${pct(avgCacheRead)})** — the real typical context size.`);
    lines.push("");
    lines.push(`### Why VSCode extension shows "X% remaining" differently`);
    lines.push(`1. VSCode probably reports PER API CALL (not summed across subagents). So its "used" tracks primary-only.`);
    lines.push(`2. VSCode doesn't auto-rotate — it trusts Claude Code's native microcompaction.`);
    lines.push(`3. Reserved-for-output budget: Claude Code reserves ~32k for Opus replies; VSCode subtracts this from "remaining". We don't.`);

    dispatch({
      type: "session.message",
      sessionId: info.id,
      message: {
        type: "session.message",
        sessionId: info.id,
        messageId: `local:context:${Date.now()}`,
        role: "assistant",
        content: lines.join("\n"),
        identity: { sub: "system:codeoid", name: "codeoid", type: "system" },
        timestamp: new Date().toISOString(),
      },
    });
  };

  const printWhoLocalMessage = (session: import("./types.js").TuiSession) => {
    const info = session.info;
    const lines: string[] = [];
    lines.push(`## Identity chain for ${info.name}`);
    lines.push("");
    lines.push(`**You** — ${info.createdBy}`);
    lines.push(`  ↓`);
    lines.push(
      `**Session agent** — \`${info.agentUri ?? "anonymous:" + info.id}\``,
    );
    const active = (info.subagents ?? []).filter((s) => s.active);
    const inactive = (info.subagents ?? []).filter((s) => !s.active);
    if (active.length === 0 && inactive.length === 0) {
      lines.push("");
      lines.push("*No sub-agents spawned in this session yet.*");
    } else {
      if (active.length > 0) {
        lines.push(`  ↓`);
        lines.push(`### Active sub-agents (${active.length})`);
        for (const s of active) {
          lines.push(
            `- **${s.agentType}** (\`${s.wimseUri ?? s.agentId}\`)`,
          );
        }
      }
      if (inactive.length > 0) {
        lines.push("");
        lines.push(`### Completed sub-agents (${inactive.length})`);
        for (const s of inactive) {
          lines.push(
            `- ${s.agentType} — \`${s.wimseUri ?? s.agentId}\``,
          );
        }
      }
    }
    const content = lines.join("\n");
    dispatch({
      type: "session.message",
      sessionId: session.info.id,
      message: {
        type: "session.message",
        sessionId: session.info.id,
        messageId: `local:who:${Date.now()}`,
        role: "assistant",
        content,
        identity: { sub: "system:codeoid", name: "codeoid", type: "system" },
        timestamp: new Date().toISOString(),
      },
    });
  };

  const handleSlashCommand = (
    cmd: string,
    args: string[] = [],
    rawText = "",
  ) => {
    const client = wsRef.current;
    switch (cmd) {
      case "/clear":
        if (focusedSession) {
          dispatch({
            type: "session.scrollback",
            sessionId: focusedSession.info.id,
            messages: [],
          });
        }
        return;
      case "/new":
        dispatch({ type: "modal.open", modal: { kind: "new-session" } });
        return;
      case "/switch":
        dispatch({ type: "modal.open", modal: { kind: "switch-session", query: "" } });
        return;
      case "/destroy":
        if (focusedSession) {
          dispatch({
            type: "modal.open",
            modal: { kind: "confirm-destroy", sessionId: focusedSession.info.id },
          });
        }
        return;
      case "/interrupt":
        if (focusedSession && client) {
          void client.interrupt(focusedSession.info.id).catch(() => {});
        }
        return;
      case "/help":
        dispatch({ type: "modal.open", modal: { kind: "help" } });
        return;
      case "/who": {
        if (!focusedSession) {
          dispatch({ type: "error", message: "no focused session" });
          return;
        }
        printWhoLocalMessage(focusedSession);
        return;
      }
      case "/mode": {
        if (args.length === 0) {
          cycleFocusedMode();
          return;
        }
        if (args.length >= 1) setSpecificMode(args[0]!, args[1]);
        return;
      }
      case "/pin": {
        if (!client || !focusedSession) return;
        if (args.length === 0) {
          dispatch({ type: "error", message: "usage: /pin <path>" });
          return;
        }
        for (const p of args) {
          void client.pin(focusedSession.info.id, stripMentionPrefix(p)).catch(() => {});
        }
        return;
      }
      case "/unpin": {
        if (!client || !focusedSession) return;
        if (args.length === 0) {
          dispatch({ type: "error", message: "usage: /unpin <path>" });
          return;
        }
        for (const p of args) {
          void client.unpin(focusedSession.info.id, stripMentionPrefix(p)).catch(() => {});
        }
        return;
      }
      case "/context": {
        if (!client || !focusedSession) return;
        // Overloaded:
        //   /context               → detailed context-budget breakdown
        //   /context <path> [...]  → one-shot file attachments for next turn
        if (args.length === 0) {
          printContextBreakdownMessage(focusedSession);
          return;
        }
        const attachments: Attachment[] = args.map((p) => ({
          path: stripMentionPrefix(p),
        }));
        const prompt = `Please review the attached file${attachments.length === 1 ? "" : "s"}.`;
        void client
          .send(focusedSession.info.id, prompt, attachments)
          .catch((err: Error) =>
            dispatch({ type: "error", message: err.message }),
          );
        return;
      }
      case "/rotate": {
        if (!client || !focusedSession) return;
        void client.rotate(focusedSession.info.id).catch((err: Error) =>
          dispatch({ type: "error", message: err.message }),
        );
        return;
      }
      case "/search": {
        // Opens the search modal pre-populated with whatever the user
        // typed after `/search`. Empty is fine — modal shows the hint.
        const initial = args.join(" ").trim();
        dispatch({
          type: "modal.open",
          modal: { kind: "search", query: initial },
        });
        return;
      }
      case "/model": {
        // No args → interactive picker modal. With an arg → direct switch
        // (skip modal, trust the user knows the alias/id they want).
        if (args.length === 0) {
          dispatch({ type: "modal.open", modal: { kind: "model" } });
          return;
        }
        if (!client || !focusedSession) return;
        const chosen = args[0]!;
        void client
          .setModel(focusedSession.info.id, chosen)
          .then((resp) => {
            if (resp.type === "response.error") {
              dispatch({ type: "error", message: resp.error });
            }
          })
          .catch((err: Error) =>
            dispatch({ type: "error", message: err.message }),
          );
        return;
      }
      default: {
        // Workspace command? Expand template and send.
        const wsCmd = workspaceCommands.find((c) => c.name === cmd);
        if (wsCmd && client && focusedSession) {
          const expanded = expandWorkspaceCommand(wsCmd, args.join(" "));
          const attachments = extractMentionAttachments(expanded);
          void client
            .send(
              focusedSession.info.id,
              expanded,
              attachments.length > 0 ? attachments : undefined,
            )
            .catch((err: Error) =>
              dispatch({ type: "error", message: err.message }),
            );
          return;
        }
        // Pass-through: unknown /command → forward verbatim to Claude Code
        // so it can pick up its own built-ins (/agent, /compact, etc.).
        if (client && focusedSession) {
          void client
            .send(focusedSession.info.id, rawText || cmd)
            .catch((err: Error) =>
              dispatch({ type: "error", message: err.message }),
            );
        }
        return;
      }
    }
  };

  // ── Modal handlers ─────────────────────────────────────────────────────

  const onSubmitNewSession = (name: string, workdir: string) => {
    const client = wsRef.current;
    if (!client) return;
    void client.createSession(name, workdir).then((resp) => {
      if (resp.type === "response.ok" && resp.data) {
        const info = resp.data as import("../protocol/types.js").SessionInfo;
        dispatch({ type: "session.add", session: info });
        dispatch({ type: "focus", sessionId: info.id });
      }
      dispatch({ type: "modal.close" });
    });
  };

  const onSelectSession = (sessionId: string) => {
    dispatch({ type: "focus", sessionId });
    dispatch({ type: "modal.close" });
  };

  const onConfirmDestroy = (sessionId: string) => {
    const client = wsRef.current;
    if (!client) return;
    void client.destroy(sessionId).then(() => {
      dispatch({ type: "session.remove", sessionId });
      dispatch({ type: "modal.close" });
    });
  };

  const onCancelModal = () => dispatch({ type: "modal.close" });

  /**
   * Search handler passed into the modal. Returns hits directly so the
   * modal stays in control of its async state (loading, error, stale).
   * Uses the focused session's workdir to anchor the workspace scope;
   * falls back to cross-workspace when nothing is focused.
   */
  const onSearch = async (q: string): Promise<import("../protocol/types.js").SessionSearchHit[]> => {
    const client = wsRef.current;
    if (!client) return [];
    const workdir = focusedSession?.info.workdir;
    const resp = await client.search(q, workdir, 10, "workspace");
    if (resp.type === "session.search.result") {
      return resp.sessions;
    }
    if (resp.type === "response.error") {
      throw new Error(resp.error);
    }
    return [];
  };

  /**
   * Model switch handler. Resolves aliases on the daemon side; we just
   * forward the user's choice. Surfaces server errors (unknown id) so
   * the modal can show them inline.
   */
  const onSetModel = async (model: string): Promise<void> => {
    const client = wsRef.current;
    if (!client || !focusedSession) return;
    const resp = await client.setModel(focusedSession.info.id, model);
    if (resp.type === "response.error") {
      throw new Error(resp.error);
    }
  };

  // ── Layout ─────────────────────────────────────────────────────────────

  const cols = stdout.columns ?? 120;

  // Prompt hint — mode-aware so users know what pressing Enter does.
  //   - waiting_approval → the approval banner (y/n shortcut)
  //   - working          → mid-turn queue hint; Enter pushes now, Claude sees mid-stream
  //   - idle             → normal send copy
  const promptHint = focusedSession?.pendingApproval
    ? `⎆ ${focusedSession.pendingApproval.toolName}: ${focusedSession.pendingApproval.description} — press y/n`
    : focusedSession?.info.status === "working"
      ? "⋯ session is working — Enter queues a mid-turn message · Ctrl-F search · Esc / Ctrl-X interrupt"
      : "Enter to send · Ctrl-N new · Ctrl-G switch · Ctrl-F search · Esc clear · Ctrl-X interrupt · ? help · Ctrl-C quit";

  // Static items: a rolling list of ALL committed messages seen so far,
  // augmented with session boundaries so switches are visible in scrollback.
  // Items are keyed so Ink's Static can dedupe — each render adds new items
  // only; previously-written ones stay in the terminal's native scrollback.
  const staticItems = useMemo(
    () => buildStaticItems(orderedSessions, state.focused),
    [orderedSessions, state.focused],
  );

  return (
    <>
      <Static items={staticItems}>
        {(item) => <StaticItemRow key={item.key} item={item} />}
      </Static>
      <Box flexDirection="column" borderStyle="round" borderColor="gray">
        <SessionTabs
          sessions={orderedSessions}
          focusedId={state.focused}
          width={cols - 2}
        />
        {focusedSession && focusedSession.live.length > 0 && (
          <>
            <HorizontalRule width={cols - 2} />
            <Box flexDirection="column" paddingX={1}>
              {focusedSession.live.map((m) => (
                <MessageRow key={m.messageId} msg={m} live />
              ))}
            </Box>
          </>
        )}
        {workingSince !== null && (
          <>
            <HorizontalRule width={cols - 2} />
            <WorkingIndicator
              startedAt={workingSince}
              agentUri={focusedSession?.info.agentUri}
              subagents={focusedSession?.info.subagents}
            />
          </>
        )}
        <HorizontalRule width={cols - 2} />
        <StatusBar
          connection={state.connection}
          focused={focusedSession}
          lastError={state.lastError}
        />
        <HorizontalRule width={cols - 2} />
        <Prompt
          value={state.input}
          cursor={state.cursor}
          onChange={(v) => dispatch({ type: "input.set", value: v })}
          onCursorChange={(pos) => dispatch({ type: "cursor.set", position: pos })}
          onSubmit={onSubmitPrompt}
          onHistoryCycle={(dir) => dispatch({ type: "history.cycle", direction: dir })}
          hint={promptHint}
          disabled={!focusedSession && !inSlashMode}
          slashSelectedIdx={slashIdx}
          fileHint={
            inMentionMode && mention
              ? { query: mention.query, matches: mentionMatches, selectedIdx: mentionIdx }
              : null
          }
        />
      </Box>
      {state.modal && (
        <Modal
          modal={state.modal}
          sessions={orderedSessions}
          focusedSession={focusedSession}
          onSubmitNewSession={onSubmitNewSession}
          onSelectSession={onSelectSession}
          onConfirmDestroy={onConfirmDestroy}
          onCancel={onCancelModal}
          onSearch={onSearch}
          onSetModel={onSetModel}
        />
      )}
    </>
  );
}

// ── Static items ────────────────────────────────────────────────────────────

type StaticItem =
  | { key: string; kind: "session-banner"; sessionName: string; workdir: string }
  | { key: string; kind: "message"; message: import("../protocol/types.js").SessionMessage };

/**
 * Build the append-only items list for Ink's Static. We emit a banner when
 * the focused session changes so users can see context shifts in scrollback,
 * then each committed message in order. Keys are stable per-item so Ink's
 * Static dedupes correctly.
 */
function buildStaticItems(
  sessions: import("./types.js").TuiSession[],
  focusedId: string | null,
): StaticItem[] {
  const items: StaticItem[] = [];
  for (const s of sessions) {
    if (s.info.id !== focusedId) continue;
    items.push({
      key: `banner:${s.info.id}`,
      kind: "session-banner",
      sessionName: s.info.name,
      workdir: s.info.workdir,
    });
    for (const m of s.committed) {
      items.push({
        key: `${s.info.id}:${m.messageId}`,
        kind: "message",
        message: m,
      });
    }
  }
  return items;
}

function HorizontalRule({ width }: { width: number }) {
  return (
    <Box>
      <Text dimColor>{"─".repeat(Math.max(0, width))}</Text>
    </Box>
  );
}

function StaticItemRow({ item }: { item: StaticItem }) {
  if (item.kind === "session-banner") {
    return (
      <Box marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text>
          <Text color="cyan" bold>
            {"▾ "}
            {item.sessionName}
          </Text>
          <Text dimColor>{"  @  "}</Text>
          <Text dimColor>{item.workdir}</Text>
        </Text>
      </Box>
    );
  }
  return <MessageRow msg={item.message} />;
}

// ── Mention helpers ────────────────────────────────────────────────────────

/**
 * Locate an active @-mention around the cursor. We look backward for `@`
 * and stop at whitespace. If the cursor is inside a `@token`, return its
 * start offset + the text between `@` and the cursor.
 */
function detectMention(
  value: string,
  cursor: number,
): { start: number; query: string } | null {
  if (cursor === 0) return null;
  // Scan backward for @ or whitespace/newline.
  let i = cursor - 1;
  while (i >= 0) {
    const ch = value[i]!;
    if (ch === "@") {
      // Must be at start of value or preceded by whitespace to count.
      if (i === 0 || /\s/.test(value[i - 1]!)) {
        return { start: i, query: value.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

/**
 * Extract `@path` tokens from submitted text and build an Attachment list.
 * Preserves the `@path` literal in the text so Claude sees the user's intent.
 */
function extractMentionAttachments(text: string): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@([A-Za-z0-9_./-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1]!;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path });
  }
  return out;
}

/** Strip a leading `@` from a user-supplied path argument. */
function stripMentionPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

/** Compact token count for the /context breakdown — "1234" / "12.3k" / "1.2M". */
function formatK(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return (n / 1_000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1_000) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}
