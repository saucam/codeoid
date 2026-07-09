/**
 * Pure pi-RPC-event → ProviderEvent translation. Stateless mappings only —
 * anything that needs turn/tool state (approvals, turn_done accounting)
 * lives in PiProvider. Kept pure so the wire mapping is unit-testable
 * without a subprocess.
 */

import type { ProviderEvent } from "../interface.js";
import type { PiFrame } from "./rpc.js";

/** Extract the concatenated text blocks from a pi message content array. */
export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("\n\n");
}

/**
 * Map one pi RPC event frame to zero-or-more ProviderEvents.
 *
 * Deliberately NOT handled here (provider-owned):
 *   - `agent_start` / `agent_end` (turn boundaries + usage accounting)
 *   - `extension_ui_request` (approvals + dialogs)
 *   - `response` frames (request correlation)
 *   - tool_start (minted from the bridge approval, where input is final)
 */
export function translatePiEvent(frame: PiFrame): ProviderEvent[] {
  switch (frame.type) {
    case "message_update": {
      const delta = frame.assistantMessageEvent as
        | { type?: string; delta?: string; contentIndex?: number }
        | undefined;
      if (!delta || typeof delta.type !== "string") return [];
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        return [{ type: "text_delta", content: delta.delta }];
      }
      if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
        return [
          {
            type: "thinking_delta",
            content: delta.delta,
            blockIndex: delta.contentIndex,
          },
        ];
      }
      if (delta.type === "thinking_end") {
        return [{ type: "thinking_done", blockIndex: delta.contentIndex }];
      }
      return [];
    }

    case "message_end": {
      const message = frame.message as
        | { role?: string; content?: unknown }
        | undefined;
      if (message?.role !== "assistant") return [];
      const text = piContentText(message.content);
      // Tool-only assistant rounds have no text — emitting an empty
      // text_done would commit a "(no output)" placeholder row.
      return text.length > 0 ? [{ type: "text_done", content: text }] : [];
    }

    case "tool_execution_update": {
      const toolName = frame.toolName;
      return [
        {
          type: "tool_progress",
          ...(typeof toolName === "string" ? { toolName } : {}),
        },
      ];
    }

    case "tool_execution_end": {
      const toolCallId = frame.toolCallId;
      if (typeof toolCallId !== "string") return [];
      const result = frame.result as { content?: unknown } | undefined;
      return [
        {
          type: "tool_complete",
          sdkToolUseId: toolCallId,
          output: piContentText(result?.content),
          success: frame.isError !== true,
        },
      ];
    }

    case "auto_retry_start": {
      return [
        {
          type: "api_retry",
          attempt: typeof frame.attempt === "number" ? frame.attempt : undefined,
          retryDelayMs: typeof frame.delayMs === "number" ? frame.delayMs : undefined,
          errorStatus: null,
        },
      ];
    }

    case "extension_error": {
      const path = typeof frame.extensionPath === "string" ? frame.extensionPath : "?";
      const error = typeof frame.error === "string" ? frame.error : "unknown error";
      return [
        {
          type: "custom_message",
          role: "system",
          content: `pi extension error (${path}): ${error}`,
          metadata: { source: "pi", kind: "extension_error" },
        },
      ];
    }

    case "compaction_start": {
      return [
        {
          type: "custom_message",
          content: `pi is compacting its context (${String(frame.reason ?? "auto")})…`,
          metadata: { source: "pi", kind: "compaction" },
        },
      ];
    }

    // Turn/summary bookkeeping the provider owns, plus chatter with no
    // codeoid rendering (queue_update, message_start, tool_execution_start —
    // tool visibility starts at the bridge approval where input is final).
    default:
      return [];
  }
}
