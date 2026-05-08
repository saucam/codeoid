/**
 * Right-pane file viewer. Read-only. Renders shiki-highlighted source
 * for text files; binary files surface their size + a "binary preview
 * not available" message. The pane animates in (via the parent grid
 * `grid-template-columns` track transition) when `openedFile()` is non-null.
 */

import { Component, Show, createResource } from "solid-js";

import { closeFile, openedFile } from "../../state/files";
import { formatTokens } from "../../lib/format";
import { SHIKI_THEME, getHighlighter } from "../../lib/shiki";

const FileViewer: Component = () => {
  return (
    <Show when={openedFile()}>
      {(file) => (
        <div class="flex h-full flex-col">
          <header class="flex items-center gap-2 border-b border-border bg-bg-elev px-3 py-2 text-[11px]">
            <span class="font-mono text-fg" title={file().path}>
              {file().path}
            </span>
            <Show when={file().language}>
              <span class="rounded border border-border px-1 py-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
                {file().language}
              </span>
            </Show>
            <Show when={file().truncated}>
              <span class="rounded border border-warn/50 px-1 py-0.5 text-[10px] uppercase tracking-wider text-warn">
                truncated
              </span>
            </Show>
            <span class="ml-auto font-mono text-[10px] text-fg-faint">
              {file().size} bytes ≈ {formatTokens(Math.round(file().size / 4))} toks
            </span>
            <button
              type="button"
              onClick={closeFile}
              class="text-fg-faint hover:text-fg"
              title="Close (Esc)"
            >
              ✕
            </button>
          </header>
          <Show
            when={!file().loading}
            fallback={
              <div class="flex flex-1 items-center justify-center text-xs text-fg-faint">
                loading…
              </div>
            }
          >
            <Show when={file().error} fallback={<Body />}>
              <div class="flex flex-1 items-center justify-center px-4 text-sm text-danger">
                {file().error}
              </div>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
};

const Body: Component = () => {
  const file = openedFile;
  const [highlighted] = createResource(
    () => {
      const f = file();
      return f && f.encoding === "utf-8" && f.content !== null
        ? { content: f.content, language: f.language }
        : null;
    },
    async (input) => {
      if (!input) return null;
      try {
        const hl = await getHighlighter();
        const lang = input.language && hl.getLoadedLanguages().includes(input.language as never)
          ? input.language
          : "text";
        return hl.codeToHtml(input.content, {
          lang,
          theme: SHIKI_THEME,
        });
      } catch (err) {
        console.warn("[codeoid] shiki failed; falling back to plain text", err);
        return null;
      }
    },
  );

  return (
    <div class="flex-1 overflow-auto">
      <Show when={file()?.encoding === "base64"}>
        <BinaryPreview />
      </Show>
      <Show when={file()?.encoding === "utf-8"}>
        <Show
          when={highlighted()}
          fallback={
            <pre class="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[12px] text-fg">
              {file()?.content}
            </pre>
          }
        >
          {/* eslint-disable-next-line solid/no-innerhtml */}
          <div
            class="shiki-out p-3 font-mono text-[12px] [&_pre]:!bg-transparent [&_pre]:!m-0"
            innerHTML={highlighted() ?? ""}
          />
        </Show>
      </Show>
    </div>
  );
};

const BinaryPreview: Component = () => (
  <div class="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center text-fg-muted">
    <p class="text-sm">Binary file — preview not available.</p>
    <p class="text-xs text-fg-faint">
      Open in your shell with <code>open</code> or <code>xdg-open</code>.
    </p>
  </div>
);

export default FileViewer;
