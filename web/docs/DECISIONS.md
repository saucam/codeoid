# Decisions log

ADR-lite. Each entry is short — the *why*, not a 10-page essay.

---

## 2026-05-04 — Solid over React

**Context:** Web UI needs to render Claude token streaming at high
frequency. May become a product / OSS.

**Decision:** Solid.js.

**Why:** Streaming token append = single-text-node update under Solid's
fine-grained reactivity vs. a tree-diff under React's VDOM (even with
the React 19 compiler, still tree-walks the assistant message). For a
tool the user runs all day on long sessions, the perf delta is felt,
not theoretical. Trade-off accepted: smaller ecosystem, less idiomatic
output from AI tooling.

**Reversibility:** Medium. Solid and React share JSX + hooks-shaped
ergonomics; a port is mechanical but not free.

---

## 2026-05-04 — No UI library (no shadcn, no Radix wrapper, no Mantine)

**Context:** The user explicitly asked for lightweight + SOTA-feeling.

**Decision:** Roll our own components. Pull in surgical small deps for
genuinely-hard primitives: `cmdk` (or hand-rolled), `@floating-ui/dom`,
`solid-markdown`, `shiki`, `@tanstack/solid-virtual`, `motion`.

**Why:** The bespoke 80% of codeoid (transcript, tool cards, prompt,
session tabs, file viewer) doesn't benefit from a generic component
library. The standard 20% is well-served by 2-3 small primitives. Keeps
the bundle under 200KB gzipped at v1, which matters for the "open and
go" SOTA feel.

**Trade-off:** ~500-1000 LoC over time we wouldn't write with shadcn.
Acceptable given the user owns every pixel and every interaction.

---

## 2026-05-04 — Daemon is single source of truth; clients are renderers

**Context:** Three frontends already exist (TUI, web, Telegram). The
user explicitly called this out: any frontend should auto-resume any
session.

**Decision:** Web client computes nothing the daemon could. No pricing
tables. No transcript persistence in localStorage. No optimistic state.

**Why:** Resume-anywhere depends on the daemon being canonical. Drift
between client computations and daemon truth is observable as wrong
totals, stale costs, ghost messages.

**Reversibility:** N/A — this is a load-bearing constraint, not a
preference.

---

## 2026-05-04 — Vite 6, not 7+

**Context:** Vite 7+ requires Node 22+. Host machine has Node 21.

**Decision:** Pin Vite to `^6.4.2`. Tailwind `@tailwindcss/vite`
matched at `^4.2.4`.

**Why:** Avoid forcing a Node upgrade on the host. Vite 6 is currently
maintained and missing nothing we want.

**Reversibility:** Trivial when host bumps Node.

---

## 2026-05-04 — Tier-1 v1 scope: chat cockpit + read-only file viewer

**Context:** The user explored "world-class editor" but landed on a
chat-first cockpit. They still want a file explorer + click-to-view.

**Decision:** v1 ships: full TUI parity for chat features + a left-side
file tree rooted at `session.workdir` + a collapsible right pane with
shiki-rendered file contents. NO in-place editing, NO LSP, NO embedded
terminal. Right pane is built as a swappable component so we can graduate
to CodeMirror 6 when we choose to.

**Why:** Tier-1 ships fast and is what the user actually uses daily.
The editor surface is its own product; let's not block parity on it.

**Reversibility:** Easy. The right pane is a mount point; the daemon's
`fs.list` / `fs.read` verbs (to be added) extend cleanly to `fs.write`
when Tier 3 lands.
