/**
 * Single transcript row. Role-aware styling, identity surfacing, optional
 * tool card, optional approval bar. Markdown for assistant messages
 * (P3 stub uses solid-markdown with shiki coming in P7).
 */

import { Component, Match, Show, Switch } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";

import { formatClock, formatDuration } from "../../lib/format";
import {
  identityColorClass,
  identityLabel,
  shortSub,
} from "../../lib/identity";
import type {
  MessageRole,
  SessionMessage,
  ToolState,
} from "../../protocol/types";

const ROLE_LABEL: Record<MessageRole, string> = {
  user: "you",
  assistant: "assistant",
  thinking: "reasoning",
  tool_call: "tool",
  tool_result: "tool output",
  system: "system",
  info: "info",
};

const ROLE_BORDER: Record<MessageRole, string> = {
  user: "border-l-role-user",
  assistant: "border-l-role-assistant",
  thinking: "border-l-role-thinking",
  tool_call: "border-l-role-tool",
  tool_result: "border-l-role-tool/60",
  system: "border-l-danger",
  info: "border-l-fg-faint",
};

const MessageRow: Component<{ msg: SessionMessage; streaming?: boolean }> = (props) => {
  const m = () => props.msg;
  const skip = () => isPlaceholder(m()) && !props.streaming;
  return (
    <Show when={!skip()}>
      <article
        data-message-id={m().messageId}
        class={`group rounded border-l-2 ${ROLE_BORDER[m().role]} bg-bg-elev/30 px-3 py-2 transition hover:bg-bg-elev/60`}
      >
        <Header msg={m()} />
        <Body msg={m()} streaming={props.streaming} />
      </article>
    </Show>
  );
};

const Header: Component<{ msg: SessionMessage }> = (props) => (
  <header class="mb-1 flex items-center gap-2 text-[11px]">
    <span
      class={`font-semibold uppercase tracking-wider ${roleColor(props.msg.role)}`}
    >
      {ROLE_LABEL[props.msg.role]}
    </span>
    <span
      class={`truncate font-mono text-fg-muted ${identityColorClass(props.msg.identity.type)}`}
      title={props.msg.identity.sub}
    >
      {identityLabel(props.msg.identity)}
    </span>
    <span class="ml-auto font-mono text-fg-faint">
      {formatClock(props.msg.timestamp)}
    </span>
  </header>
);

const Body: Component<{ msg: SessionMessage; streaming?: boolean }> = (props) => {
  const m = () => props.msg;
  return (
    <Switch fallback={<Plain text={m().content} />}>
      <Match when={m().role === "tool_call" && m().tool}>
        <ToolBlock msg={m()} />
      </Match>
      <Match when={m().role === "tool_result"}>
        <ToolResult msg={m()} />
      </Match>
      <Match when={m().role === "thinking"}>
        <ThinkingBlock text={m().content} streaming={props.streaming} />
      </Match>
      <Match when={m().role === "assistant"}>
        <MarkdownBlock text={m().content} streaming={props.streaming} />
      </Match>
      <Match when={m().role === "info"}>
        <InfoBlock msg={m()} />
      </Match>
      <Match when={m().role === "user" || m().role === "system"}>
        <Plain text={m().content} />
      </Match>
    </Switch>
  );
};

const Plain: Component<{ text: string }> = (props) => (
  <div class="whitespace-pre-wrap break-words text-sm text-fg">
    {props.text}
  </div>
);

const MarkdownBlock: Component<{ text: string; streaming?: boolean }> = (props) => (
  <div class="md-prose">
    <SolidMarkdown
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      remarkPlugins={[remarkGfm as any]}
      children={props.text}
    />
    <Show when={props.streaming}>
      <span class="md-streaming-caret" aria-label="streaming" />
    </Show>
  </div>
);

const ThinkingBlock: Component<{ text: string; streaming?: boolean }> = (props) => (
  <details class="text-[12px] italic text-role-thinking" open={props.streaming}>
    <summary class="cursor-pointer select-none text-fg-faint hover:text-fg-muted">
      reasoning ({props.text.split("\n").length} lines)
      <Show when={props.streaming}>
        <span class="md-streaming-caret ml-1" aria-label="streaming" />
      </Show>
    </summary>
    <div class="mt-1 whitespace-pre-wrap pl-3">{props.text}</div>
  </details>
);

const ToolBlock: Component<{ msg: SessionMessage }> = (props) => {
  const t = () => props.msg.tool!;
  return (
    <div class="space-y-1">
      <div class="flex items-center gap-2 font-mono text-xs">
        <span class="font-semibold text-role-tool">{t().name}</span>
        <PhaseBadge state={t().state} />
        <span class="ml-auto text-fg-faint">{shortSub(t().toolId)}</span>
      </div>
      <ToolStateBody
        state={t().state}
        description={props.msg.content}
        toolName={t().name}
      />
    </div>
  );
};

/**
 * Waiting-confirmation body. For `ExitPlanMode` we make the plan
 * content the *primary* surface (markdown-rendered) — that's what the
 * user actually needs to read before approving. For every other tool
 * we show the description and a collapsible JSON view of the full
 * `input` so the user can audit exactly what the tool will do.
 */
const WaitingConfirmationBody: Component<{
  state: Extract<ToolState, { phase: "waiting_confirmation" }>;
  toolName: string;
}> = (props) => {
  const isPlanMode = () =>
    props.toolName === "ExitPlanMode" || props.toolName === "exit_plan_mode";
  const plan = () => {
    const input = props.state.input;
    if (input && typeof input === "object" && "plan" in input) {
      const p = (input as { plan: unknown }).plan;
      return typeof p === "string" ? p : null;
    }
    return null;
  };
  return (
    <Switch>
      <Match when={isPlanMode() && plan()}>
        <div class="rounded border border-accent/30 bg-accent/[0.04] p-3">
          <div class="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-accent">
            <span>📋</span>
            <span class="font-semibold">Proposed plan</span>
          </div>
          <MarkdownBlock text={plan()!} />
        </div>
      </Match>
      <Match when={!isPlanMode()}>
        <div class="space-y-1.5">
          <div class="rounded bg-bg-active/50 px-2 py-1.5 text-sm text-fg">
            {props.state.description}
          </div>
          <details class="text-[11px]">
            <summary class="cursor-pointer text-fg-faint hover:text-fg-muted">
              full input
            </summary>
            <pre class="mt-1 whitespace-pre-wrap break-words rounded border border-border bg-bg-active/40 p-2 font-mono text-[11px] text-fg-muted">
              {JSON.stringify(props.state.input, null, 2)}
            </pre>
          </details>
        </div>
      </Match>
    </Switch>
  );
};

const PhaseBadge: Component<{ state: ToolState }> = (props) => {
  const phase = props.state.phase;
  const cls =
    phase === "completed"
      ? "border-success/40 text-success"
      : phase === "executing" || phase === "streaming"
        ? "border-warn/40 text-warn animate-pulse"
        : phase === "waiting_confirmation"
          ? "border-accent/40 text-accent"
          : phase === "cancelled"
            ? "border-danger/40 text-danger"
            : "border-border text-fg-faint";
  return (
    <span
      class={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}
    >
      {phase.replace("_", " ")}
    </span>
  );
};

const ToolStateBody: Component<{
  state: ToolState;
  description: string;
  toolName: string;
}> = (props) => (
  <Switch fallback={<Plain text={props.description} />}>
    <Match when={props.state.phase === "waiting_confirmation"}>
      <WaitingConfirmationBody
        state={props.state as Extract<ToolState, { phase: "waiting_confirmation" }>}
        toolName={props.toolName}
      />
    </Match>
    <Match when={props.state.phase === "executing"}>
      <Show when={(props.state as { progress?: string }).progress}>
        <div class="text-xs text-fg-muted">
          {(props.state as { progress?: string }).progress}
        </div>
      </Show>
      <Show when={(props.state as { elapsedMs?: number }).elapsedMs}>
        <div class="text-[11px] font-mono text-fg-faint">
          {formatDuration((props.state as { elapsedMs: number }).elapsedMs)}
        </div>
      </Show>
    </Match>
    <Match when={props.state.phase === "completed"}>
      <Show when={(props.state as { output?: string }).output}>
        <pre class="whitespace-pre-wrap break-words rounded bg-bg-active/40 px-2 py-1.5 font-mono text-[12px] text-fg">
          {(props.state as { output?: string }).output}
        </pre>
      </Show>
    </Match>
    <Match when={props.state.phase === "cancelled"}>
      <div class="text-xs text-danger">
        cancelled — {(props.state as { reason: string }).reason}
        <Show when={(props.state as { message?: string }).message}>
          : {(props.state as { message?: string }).message}
        </Show>
      </div>
    </Match>
  </Switch>
);

const ToolResult: Component<{ msg: SessionMessage }> = (props) => (
  <pre class="whitespace-pre-wrap break-words rounded border-l-2 border-l-role-tool/40 bg-bg-active/30 px-3 py-2 font-mono text-[12px] text-fg">
    {props.msg.content}
  </pre>
);

const InfoBlock: Component<{ msg: SessionMessage }> = (props) => {
  const event = (props.msg.metadata?.["event"] as string | undefined) ?? "";
  const isIdentity = event === "identity.registered";
  return (
    <div
      class={`rounded border px-2 py-1.5 text-[12px] ${
        isIdentity
          ? "border-role-tool/40 bg-role-tool/5 text-role-tool"
          : "border-border bg-bg-active/30 text-fg-muted"
      }`}
    >
      <Show when={isIdentity}>
        <div class="mb-0.5 font-semibold uppercase tracking-wider">
          identity registered
        </div>
      </Show>
      <div class="font-mono text-[11px]">{props.msg.content}</div>
    </div>
  );
};

function roleColor(role: MessageRole): string {
  switch (role) {
    case "user":
      return "text-role-user";
    case "assistant":
      return "text-role-assistant";
    case "thinking":
      return "text-role-thinking";
    case "tool_call":
    case "tool_result":
      return "text-role-tool";
    case "system":
      return "text-danger";
    case "info":
    default:
      return "text-fg-faint";
  }
}

function isPlaceholder(m: SessionMessage): boolean {
  // Empty assistant placeholders mid-stream — daemon publishes these
  // before any deltas arrive. Worker row will indicate "thinking" instead.
  return (
    !m.content && (!m.parts || m.parts.length === 0) && !m.tool
  );
}

export default MessageRow;
