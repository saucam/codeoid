/**
 * Help modal — lists every slash command + syntax. Opened by `/help`
 * (and could be wired to a keyboard shortcut later).
 *
 * Static content: the command set lives in prompt/slash.ts as a fixed
 * client-side verb list, so there's nothing to fetch from the daemon —
 * this just documents what parseSlash() accepts. Keep the two in sync.
 */

import { Component, For, Show, createSignal, onCleanup, onMount } from "solid-js";

const [openSignal, setOpenSignal] = createSignal(false);

/** Open the help modal programmatically (wired to the `/help` slash command). */
export function openHelpModal(): void {
  setOpenSignal(true);
}

export function closeHelpModal(): void {
  setOpenSignal(false);
}

interface CommandDoc {
  usage: string;
  desc: string;
}

const COMMANDS: readonly CommandDoc[] = [
  { usage: "/new <name> [workdir]", desc: "Create a session (workdir defaults to .)" },
  { usage: "/rename <name>", desc: "Rename the focused session" },
  { usage: "/destroy", desc: "Destroy the focused session" },
  { usage: "/interrupt", desc: "Interrupt the current turn" },
  { usage: "/rotate", desc: "Rotate context — fresh backing session, memory preserved" },
  { usage: "/mode <i|a|x>", desc: "Switch mode: interactive · auto-allow · autonomous" },
  { usage: "/model <id|alias> [fallback]", desc: "Switch model: opus / sonnet / haiku, or a full claude-* id" },
  { usage: "/agents", desc: "Show subagents available to this session" },
  { usage: "/skills", desc: "Show skills available to this session" },
  { usage: "/mcp", desc: "Show MCP servers + their commands" },
  { usage: "/hooks", desc: "Show configured hooks" },
  { usage: "/who", desc: "Show the connected ZeroID identity" },
  { usage: "/export", desc: "Export / share the focused session" },
  { usage: "/import", desc: "Import (fork) a session from a share" },
  { usage: "/clear", desc: "Clear the prompt box" },
  { usage: "/help", desc: "Show this list" },
];

const HelpModal: Component = () => {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openSignal()) {
        e.preventDefault();
        setOpenSignal(false);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={openSignal()}>
      <div
        class="fixed inset-0 z-40 flex items-start justify-center bg-bg/70 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpenSignal(false);
        }}
      >
        <div class="mt-[12vh] w-full max-w-xl rounded-lg border border-border bg-bg-elev shadow-2xl">
          <div class="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span class="text-sm font-semibold text-fg">Slash commands</span>
            <button
              type="button"
              class="text-fg-faint hover:text-fg"
              onClick={() => setOpenSignal(false)}
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
          <div class="max-h-[60vh] overflow-y-auto px-2 py-2">
            <For each={COMMANDS}>
              {(c) => (
                <div class="flex items-baseline gap-3 rounded px-2 py-1.5 hover:bg-bg">
                  <code class="min-w-[14rem] shrink-0 font-mono text-xs text-accent">
                    {c.usage}
                  </code>
                  <span class="text-xs text-fg-muted">{c.desc}</span>
                </div>
              )}
            </For>
          </div>
          <div class="border-t border-border px-4 py-2">
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Models (for /model)
            </div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
              <span><code class="font-mono text-accent">opus</code> — Opus 4.7 (deepest reasoning)</span>
              <span><code class="font-mono text-accent">sonnet</code> — Sonnet 4.6 (fast default)</span>
              <span><code class="font-mono text-accent">haiku</code> — Haiku 4.5 (cheapest)</span>
            </div>
            <div class="mt-1 text-[11px] text-fg-faint">
              …or any full <code class="font-mono">claude-*</code> id. Enter sends · Shift+Enter newline · Esc closes
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default HelpModal;
