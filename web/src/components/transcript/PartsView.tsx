/**
 * Rich `parts[]` renderer — the protocol's ContentPart union, rendered.
 *
 * Until now the daemon only ever emitted a single text part mirroring
 * `content`, so no client rendered parts at all. Providers can now attach
 * real rich blocks (custom_message events): code, diffs, tables, trees,
 * progress rows, buttons. This component renders each known kind and
 * silently skips unknown ones (the wire contract: ignore unknown kinds).
 *
 * Buttons dispatch `session.part_action` — the daemon validates the button
 * really exists on this message before forwarding to the provider.
 */

import { Component, For, Match, Show, Switch, createSignal } from "solid-js";
import { SolidMarkdown } from "solid-markdown";
import remarkGfm from "remark-gfm";

import type { ContentPart, TreeNode } from "../../protocol/types";
import { safeImageUri, safeLinkUri } from "../../lib/sanitize-url";
import { newRequestId, request } from "../../state/connection";

const PartsView: Component<{
  parts: ContentPart[];
  sessionId: string;
  messageId: string;
}> = (props) => (
  <div class="space-y-2">
    <For each={props.parts}>
      {(part) => (
        <PartView part={part} sessionId={props.sessionId} messageId={props.messageId} />
      )}
    </For>
  </div>
);

const PartView: Component<{
  part: ContentPart;
  sessionId: string;
  messageId: string;
}> = (props) => {
  const p = () => props.part;
  return (
    <Switch>
      <Match when={p().kind === "text"}>
        <TextPartView part={p() as Extract<ContentPart, { kind: "text" }>} />
      </Match>
      <Match when={p().kind === "code"}>
        <CodePartView part={p() as Extract<ContentPart, { kind: "code" }>} />
      </Match>
      <Match when={p().kind === "file_ref"}>
        <FileRefPartView part={p() as Extract<ContentPart, { kind: "file_ref" }>} />
      </Match>
      <Match when={p().kind === "diff"}>
        <DiffPartView part={p() as Extract<ContentPart, { kind: "diff" }>} />
      </Match>
      <Match when={p().kind === "tree"}>
        <TreePartView part={p() as Extract<ContentPart, { kind: "tree" }>} />
      </Match>
      <Match when={p().kind === "button"}>
        <ButtonPartView
          part={p() as Extract<ContentPart, { kind: "button" }>}
          sessionId={props.sessionId}
          messageId={props.messageId}
        />
      </Match>
      <Match when={p().kind === "progress"}>
        <ProgressPartView part={p() as Extract<ContentPart, { kind: "progress" }>} />
      </Match>
      <Match when={p().kind === "image"}>
        <ImagePartView part={p() as Extract<ContentPart, { kind: "image" }>} />
      </Match>
      <Match when={p().kind === "anchor"}>
        <AnchorPartView part={p() as Extract<ContentPart, { kind: "anchor" }>} />
      </Match>
      <Match when={p().kind === "table"}>
        <TablePartView part={p() as Extract<ContentPart, { kind: "table" }>} />
      </Match>
      {/* Unknown kinds: render nothing — additive wire evolution. */}
    </Switch>
  );
};

const TextPartView: Component<{ part: Extract<ContentPart, { kind: "text" }> }> = (props) => (
  <Show
    when={props.part.markdown !== false}
    fallback={<div class="whitespace-pre-wrap break-words text-sm text-fg">{props.part.text}</div>}
  >
    <div class="md-prose">
      <SolidMarkdown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        remarkPlugins={[remarkGfm as any]}
        transformLinkUri={safeLinkUri}
        transformImageUri={safeImageUri}
        renderingStrategy="memo"
        children={props.part.text}
      />
    </div>
  </Show>
);

const CodePartView: Component<{ part: Extract<ContentPart, { kind: "code" }> }> = (props) => (
  <div>
    <Show when={props.part.filePath}>
      <div class="mb-0.5 font-mono text-[11px] text-fg-muted">{props.part.filePath}</div>
    </Show>
    <pre class="overflow-x-auto whitespace-pre rounded bg-bg-elev/60 px-3 py-2 text-[13px] leading-relaxed">
      <code>{props.part.code}</code>
    </pre>
  </div>
);

const FileRefPartView: Component<{ part: Extract<ContentPart, { kind: "file_ref" }> }> = (props) => (
  <div class="inline-flex items-center gap-2 rounded border border-border bg-bg-active/30 px-2 py-1 font-mono text-[12px] text-fg">
    <span>📄</span>
    <span>{props.part.path}</span>
    <Show when={props.part.lines}>
      {(lines) => (
        <span class="text-fg-muted">
          :{lines()[0]}–{lines()[1]}
        </span>
      )}
    </Show>
    <Show when={props.part.change}>
      {(change) => (
        <span>
          <span class="text-success">+{change().added}</span>{" "}
          <span class="text-danger">−{change().removed}</span>
        </span>
      )}
    </Show>
  </div>
);

const DiffPartView: Component<{ part: Extract<ContentPart, { kind: "diff" }> }> = (props) => (
  <div class="inline-flex items-center gap-2 rounded border border-border bg-bg-active/30 px-2 py-1 font-mono text-[12px]">
    <span class="text-fg">{props.part.path}</span>
    <span class="text-success">+{props.part.added}</span>
    <span class="text-danger">−{props.part.removed}</span>
  </div>
);

const TreePartView: Component<{ part: Extract<ContentPart, { kind: "tree" }> }> = (props) => (
  <div class="rounded border border-border bg-bg-elev/40 px-3 py-2">
    <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
      {props.part.label}
    </div>
    <TreeNodes nodes={props.part.children} />
  </div>
);

const TreeNodes: Component<{ nodes: TreeNode[] }> = (props) => (
  <ul class="space-y-0.5 pl-3 font-mono text-[12px] text-fg">
    <For each={props.nodes}>
      {(node) => (
        <li>
          <span>{node.type === "directory" ? "📁" : "📄"}</span> {node.label}
          <Show when={node.children && node.children.length > 0}>
            <TreeNodes nodes={node.children!} />
          </Show>
        </li>
      )}
    </For>
  </ul>
);

const ButtonPartView: Component<{
  part: Extract<ContentPart, { kind: "button" }>;
  sessionId: string;
  messageId: string;
}> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const styleClass = () =>
    props.part.style === "danger"
      ? "border-danger/50 text-danger hover:bg-danger/10"
      : props.part.style === "primary"
        ? "bg-accent text-bg font-semibold hover:opacity-90"
        : "border-border text-fg hover:bg-bg-active";
  return (
    <span class="inline-flex items-center gap-2">
      <button
        type="button"
        class={`rounded border px-3 py-1 text-sm transition disabled:opacity-40 ${styleClass()}`}
        disabled={busy()}
        onClick={() => {
          setBusy(true);
          setError(null);
          request({
            type: "session.part_action",
            id: newRequestId(),
            sessionId: props.sessionId,
            messageId: props.messageId,
            action: props.part.action,
            ...(props.part.data !== undefined ? { data: props.part.data } : {}),
          })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        {props.part.label}
      </button>
      <Show when={error()}>
        <span class="text-[11px] text-danger">{error()}</span>
      </Show>
    </span>
  );
};

const ProgressPartView: Component<{ part: Extract<ContentPart, { kind: "progress" }> }> = (props) => (
  <div class="flex items-center gap-2 text-[12px] text-fg-muted">
    <Show
      when={props.part.percent !== undefined}
      fallback={<span class="animate-pulse">⏳</span>}
    >
      <div class="h-1.5 w-32 overflow-hidden rounded bg-bg-active">
        <div
          class="h-full bg-accent transition-all"
          style={{ width: `${Math.min(100, Math.max(0, props.part.percent ?? 0))}%` }}
        />
      </div>
    </Show>
    <span>{props.part.message}</span>
  </div>
);

const ImagePartView: Component<{ part: Extract<ContentPart, { kind: "image" }> }> = (props) => {
  const safe = () => safeImageUri(props.part.url);
  return (
    <Show when={safe()}>
      <img
        src={safe()}
        alt={props.part.alt ?? ""}
        class="max-h-64 max-w-full rounded border border-border"
      />
    </Show>
  );
};

const AnchorPartView: Component<{ part: Extract<ContentPart, { kind: "anchor" }> }> = (props) => {
  const safe = () => safeLinkUri(props.part.uri);
  return (
    <Show when={safe()} fallback={<span class="text-sm text-fg">{props.part.title}</span>}>
      <a
        href={safe()}
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {props.part.title}
      </a>
    </Show>
  );
};

const TablePartView: Component<{ part: Extract<ContentPart, { kind: "table" }> }> = (props) => (
  <div class="overflow-x-auto">
    <table class="min-w-[50%] border-collapse text-[13px]">
      <thead>
        <tr>
          <For each={props.part.headers}>
            {(h) => (
              <th class="border border-border bg-bg-active/40 px-2 py-1 text-left font-semibold text-fg">
                {h}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.part.rows}>
          {(row) => (
            <tr>
              <For each={row}>
                {(cell) => <td class="border border-border px-2 py-1 text-fg">{cell}</td>}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  </div>
);

/**
 * True when a message's parts carry something the plain `content` string
 * doesn't already cover. The daemon mirrors simple text into a single text
 * part on commit — rendering THAT via PartsView would bypass the streaming
 * markdown pipeline for no gain, so the caller keeps the legacy path.
 */
export function hasRichParts(parts: ContentPart[] | undefined): boolean {
  if (!parts || parts.length === 0) return false;
  return parts.length > 1 || parts[0]!.kind !== "text";
}

export default PartsView;
