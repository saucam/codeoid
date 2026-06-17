# Codeoid

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000000.svg?logo=bun)](https://bun.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Identity-first control plane for AI coding agents — multi-session, multi-frontend, with cross-session memory.**

Run N parallel Claude Code sessions across repos. Switch between them from a terminal cockpit, a web UI, or Telegram. Every action auditable; every agent (and sub-agent) has a cryptographic identity via [ZeroID](https://github.com/highflame-ai/zeroid). Memory persists across sessions so Claude inherits what it learned last time.

> **Terminal client lives in its own repo.** The recommended cockpit is [**codeoid-tui**](https://github.com/saucam/codeoid-ui) — a native Rust/[Ratatui](https://ratatui.rs) client that speaks the daemon's WebSocket protocol. A built-in `codeoid tui` (Ink/React) ships in this repo as a zero-install fallback. See [Terminal client](#terminal-client).

```
  Terminal TUI  ──┐
  Web UI         ──┼──▶  Codeoid Daemon (Bun)  ──▶  Claude Agent SDK
  Telegram       ──┘         │         │
                             │         └──▶  ZeroID (identity + audit)
                             └──▶  Memory (SQLite + embeddings)
```

## Why Codeoid

You're orchestrating AI coding agents. Codeoid solves the things Claude Code's single-terminal experience can't:

- **Parallel sessions, shared workspace memory** — Two sessions on two git worktrees building feature A and feature B. Both inherit the same workspace's history. Session B can `recall()` what Session A learned yesterday, no re-read.
- **Never-lose-detail memory** — Every tool call, result, and reasoning block persists as a retrievable episode. No lossy compaction. Recall returns the real bytes.
- **Three-layer context reduction** — Pre-entry compression of CLI output + auto-rotation of the backing context + verbatim recall. Turns that would have cost $0.30 drop to pennies; peak occupancy stays below compaction.
- **Mid-turn streaming input (VSCode parity)** — Send a follow-up message while Claude is already responding. Priority semantics (`now` / `next` / `later`) let you interrupt-and-re-integrate or gracefully queue for the next turn.
- **Production-grade token instrumentation** — Per-turn input/output/cache/cost persisted to SQLite. Live StatusBar shows cumulative + Δ this-turn + cache hit rate + current context occupancy + queue depth + rotation count.
- **Autonomous runs with a budget** — Flip a session to autonomous mode; it auto-approves safe operations until a write/exec budget is spent, then hands control back.
- **Device handoff** — Start a session on your laptop, attach from your phone. Scrollback replays. Same conversation.
- **Identity-grade audit** — Every tool call stamped with the SPIFFE URI of the agent that made it. Sub-agents get their own attenuated identities. Delegation chain traceable top to bottom.
- **Multi-frontend** — same session accessible from terminal TUI, browser, or Telegram bot. Share read-only tokens with a teammate.

## How Codeoid compares

Codeoid is not a general-purpose IDE assistant — it's aimed at **long-horizon multi-session agent work** where context continuity and token economics matter more than inline code actions. Here's where it differs from the tools you're probably already using:

| Capability | Claude Code CLI (interactive) | VSCode Extension | Cursor | Aider | **Codeoid** |
|---|:-:|:-:|:-:|:-:|:-:|
| **Cross-session verbatim memory** | ❌ `/compact` is lossy | ❌ session-scoped | ❌ | ❌ | ✅ SQLite + FTS5 + vectors, workspace-scoped |
| **Parallel sessions, one control plane** | ❌ one terminal | ❌ one window per repo | ~ tabs | ❌ | ✅ N sessions, switch with Ctrl-G |
| **Git-worktree-aware memory sharing** | ❌ | ❌ | ❌ | ❌ | ✅ anchored on `git-common-dir` |
| **Workspace memory index** injected into system prompt | ❌ | ❌ | ❌ | ~ repo map | ✅ hot files + topic clusters + recent sessions, auto-regenerated |
| **Pre-entry CLI output compression** (git diff, test runners, etc.) with recall recovery | ❌ | ❌ | ❌ | ❌ | ✅ declarative rules, 60-90% reduction with tee-cache |
| **Auto-rotation of backing context** near compaction ceiling | ❌ | ❌ | ❌ | ❌ | ✅ lossless via memory recall seed |
| **Mid-turn user input (stream)** | ❌ interactive CLI is turn-based | ✅ | ~ | ❌ | ✅ with `now`/`next`/`later` priority |
| **Per-turn token / cost / cache telemetry** | ~ `/cost` total only | ❌ | ❌ | ~ | ✅ persistent SQLite, StatusBar, Δ per turn |
| **Current context occupancy visible** | ❌ | ❌ | ❌ | ❌ | ✅ `ctx 65k/1.0M (7%)` live in StatusBar |
| **Cryptographic identity per agent + sub-agent** (SPIFFE) | ❌ | ❌ | ❌ | ❌ | ✅ ZeroID WIMSE URIs |
| **Autonomous mode with write-action budget** | ❌ | ~ | ~ | ❌ | ✅ budget tracked per session |
| **Multi-frontend (TUI + Web + Telegram)** | ❌ CLI only | ❌ IDE only | ❌ IDE only | ❌ | ✅ same session on all three |
| **Device handoff** (start laptop, continue phone) | ❌ | ❌ | ❌ | ❌ | ✅ WS re-attach with scrollback replay |
| **Inline IDE code actions** | ❌ | ✅ | ✅ | ~ | ❌ not our niche |
| **SWE-bench / automated coding benchmark score** | — | — | ✅ | ✅ | ❌ not yet benchmarked |
| **Multi-model routing** (Opus for plan, Haiku for cheap subtasks) | ~ recent | ~ | ✅ | ✅ | ❌ roadmap |

Legend: ✅ first-class · ~ partial · ❌ not supported · — not a meaningful comparison

**Translation**: if you're working on a big codebase over weeks, occasionally switching devices, and you care that Claude *remembers* rather than re-summarizes — Codeoid is the frontier. If you want "fix this function I'm looking at right now" — Cursor is still sharper.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- Claude Code CLI logged in (`claude login`) or `ANTHROPIC_API_KEY` set
- A ZeroID identity — either the hosted Highflame SaaS (no infra) or a [self-hosted ZeroID](https://github.com/highflame-ai/zeroid)

### Install

```bash
git clone https://github.com/saucam/codeoid.git
cd codeoid
bun install
```

### Authenticate

Codeoid needs one thing to start: a ZeroID key. Two ways to get one.

**Option A — Highflame SaaS (recommended, no infra)**

1. Sign up at [highflame.ai](https://highflame.ai) and open Studio → **Code Agents**.
2. Create a key (you'll get a `zid_sk_...`).
3. Log in — Codeoid ships pointing at the Highflame SaaS issuer, so there's nothing else to configure:

   ```bash
   bun src/cli.ts login          # prompts for the key (hidden), verifies it, saves to ~/.codeoid/config.json
   ```

**Option B — Self-hosted ZeroID**

Run your own [ZeroID](https://github.com/highflame-ai/zeroid), register an agent to get a key, then point Codeoid at it. `--zeroid` accepts a preset (`highflame`, `highflame-dev`, `local`) or any URL:

```bash
bun src/cli.ts login --zeroid local                       # local ZeroID on :8899
bun src/cli.ts login --zeroid https://zeroid.mycorp.com   # your deployment
```

The issuer is pinned to whatever you log in against — a token minted by any other issuer is rejected. `login` exchanges the key on the spot and prints the subject + granted scopes so you know it works before the daemon ever starts.

### Run

```bash
# Start the daemon — serves TUI/web/Telegram + mounts memory
bun src/cli.ts start
```

Then connect a client:

```bash
# Recommended: the native Rust cockpit (separate repo).
#   git clone https://github.com/saucam/codeoid-ui && cd codeoid-ui
#   cargo run -p codeoid-tui --release
#
# Or the built-in fallback TUI (Ink/React, no extra install):
bun src/cli.ts tui
```

Or browse to http://localhost:7400/ui/ for the web UI.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Codeoid Daemon (Bun)                          │
│                                                                     │
│   ┌──────────────────┐       ┌────────────────────────────────┐     │
│   │ Session Manager  │──────▶│ Memory Engine                   │     │
│   │                  │       │ ┌─────────────┐ ┌────────────┐ │     │
│   │ - mode + budget  │       │ │  Chunker    │ │  Ranker    │ │     │
│   │ - pinned files   │       │ │ (episodes)  │ │ (hybrid)   │ │     │
│   │ - subagent tree  │       │ └─────────────┘ └────────────┘ │     │
│   │ - scrollback     │       │ ┌─────────────────────────────┐ │     │
│   │ - transcript     │       │ │  SQLite + FTS5 + vectors    │ │     │
│   └──────────────────┘       │ │  (embeddings, episodes,     │ │     │
│          │                    │ │   file-read cache)          │ │     │
│          ▼                    │ └─────────────────────────────┘ │     │
│   ┌──────────────────┐       │         ▲                       │     │
│   │ Claude Agent SDK │───────┤         │ recall(), timeline(), │     │
│   │ (per session)    │       │         │ recall_file()         │     │
│   └──────────────────┘       │ ┌──────────────────────────────┐│     │
│          │                    │ │  MCP Server (in-process)     ││     │
│          ▼                    │ └──────────────────────────────┘│     │
│   ┌──────────────────┐       └────────────────────────────────┘     │
│   │ ZeroID Client    │       ┌────────────────────────────────┐     │
│   │ - register       │       │ Frontends                      │     │
│   │ - attenuated     │──────▶│  - TUI (Ink)                   │     │
│   │   sub-agent      │       │  - Web UI (SolidJS at /ui)     │     │
│   │   tokens         │       │  - Telegram (grammy)           │     │
│   └──────────────────┘       └────────────────────────────────┘     │
│          │                                                           │
│          ▼                                                           │
│       ZeroID                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

Sessions are daemon-owned. Clients are stateless; they attach, receive scrollback replay, and stream live deltas. Detach and re-attach from anywhere.

## Features

### Terminal client

Codeoid has two terminal cockpits, both speaking the daemon's WebSocket protocol:

- **[codeoid-tui](https://github.com/saucam/codeoid-ui) (recommended)** — a native
  Rust/[Ratatui](https://ratatui.rs) client in its own repo. A true cell-matrix
  framebuffer, so it stays jitter-free under high-frequency streaming deltas.
  Build once (`cargo run -p codeoid-tui --release`) and point it at the daemon.
- **Built-in `codeoid tui` (Ink/React)** — ships in this repo as a zero-install
  fallback. Documented below. Same protocol, same daemon; codeoid-tui supersedes it.

`bun src/cli.ts tui` launches the built-in Ink cockpit with everything in one view:

```
[▾ studio2  @  /Workspace/codeoid]

You
  use the Explore agent to survey src/daemon and summarize

Claude
  I'll use the general-purpose agent to explore the structure...

[general-purpose] ✓ Glob **/*.ts
[general-purpose] ✓ Read src/daemon/session.ts
  1  /**
  2   * Session — wraps a single Claude Agent SDK query...
  ...

Claude
  ## Summary
  The daemon module has 14 files. Key layers:
  ...

╭──────────────────────────────────────────────────────────────╮
│ ● test  ▸● studio2 ᴀ⚡ 📌1  ● core                            │
│──────────────────────────────────────────────────────────────│
│ ⠋ Reasoning…  4s  ·  Ctrl-X to interrupt                     │
│ acting as …/agent/codeoid-session-7838ee1d                   │
│   via general-purpose  …/subagent/explorer-abc               │
│──────────────────────────────────────────────────────────────│
│ ● connected · studio2 @ /Workspace/codeoid · working · mode: autonomous (42 actions left) │
│──────────────────────────────────────────────────────────────│
│  Enter to send · Ctrl-N new · Ctrl-G switch · ? help         │
│ › _                                                          │
╰──────────────────────────────────────────────────────────────╯
```

**Keybindings:**

| Key | Action |
|---|---|
| `Ctrl-N` | New session |
| `Ctrl-G` | Switch session (fuzzy) |
| `Ctrl-D` | Destroy focused session |
| `Ctrl-X` | Interrupt focused session |
| `Esc` | Clear input draft — or interrupt if input is empty and session is working |
| `Shift-Tab` / `Ctrl-M` | Cycle execution mode |
| `y` / `n` | Approve / deny pending tool (when input empty) |
| `?` | Show keybindings overlay |
| `Ctrl-C` | Quit the TUI (sessions keep running) |

**Prompt editor:**

| Key | Action |
|---|---|
| `Enter` | Send |
| `Alt-Enter` / `Ctrl-J` / `\↵` | Insert newline |
| `Up` / `Down` | Cycle prompt history |
| `Ctrl-A` / `Ctrl-E` | Line start / end |
| `Ctrl-U` / `Ctrl-K` | Clear to start / end |
| `Ctrl-W` | Delete previous word |
| `@<path>` | Autocomplete a workspace file → attaches to send |
| `/` | Slash-command hint overlay |

**Slash commands** (built-in):

| Command | Action |
|---|---|
| `/clear` | Clear the visible transcript (memory kept) |
| `/new` | New session (opens modal) |
| `/switch` | Switch session (opens picker) |
| `/destroy` | Destroy focused session |
| `/interrupt` | Interrupt focused session |
| `/mode [target] [budget]` | Set execution mode. `/mode autonomous 100` = 100 write actions budget; `/mode autonomous 0` = unbounded |
| `/pin <path>` | Pin a file — prepended to every turn |
| `/unpin <path>` | Unpin a file |
| `/context <path>…` | Attach files to the NEXT turn only |
| `/rotate` | Roll over the Claude Code backing session — fresh context, memory preserved |
| `/who` | Print the identity chain (user → agent → sub-agents) |
| `/help` | Show keybindings |

**Pass-through**: any `/command` that isn't a Codeoid built-in or a workspace command is forwarded verbatim to Claude Code — `/compact`, `/agent`, custom subcommands all work without Codeoid knowing about them.

**Workspace commands**: any `.claude/commands/*.md` in your workspace auto-loads as a slash command on session focus. The file body becomes the prompt template; `$ARGUMENTS` is substituted with whatever the user typed after the command name. Zero Codeoid changes when you add new commands.

### Cross-session memory

Codeoid records every tool call, result, and reasoning block as an **episode** — stored verbatim, never summarized, retrievable via hybrid search. Claude gains three tools:

- `recall(query)` — semantic + keyword search across all prior sessions in this workspace
- `recall_file(path)` — check if a file was read recently; skip the re-read if cached
- `timeline(limit)` — chronological list of recent activity across sessions

Memory is **workspace-scoped via `git rev-parse --git-common-dir`**, so all [git worktrees](#parallel-sessions--git-worktrees) of the same repo share one workspace — feature branches inherit the main line's knowledge.

**What's in the store:**

```
~/.codeoid/memory.db            — SQLite (episodes + FTS5 + embeddings)
~/.codeoid/models/              — BGE-small-en-v1.5 (~50MB, downloaded once)
```

**Ranking:**

| Signal | Weight | Purpose |
|---|---|---|
| Vector similarity (BGE-small cosine) | 0.55 | Semantic match |
| FTS5 BM25 | 0.25 | Exact-string / function-name match |
| Recency (48h half-life) | 0.12 | Prefer recent context |
| Path overlap | 0.08 | Files touched in common |

**No external spend** — embeddings run in-process via `@xenova/transformers` (WASM). Configurable to Ollama, OpenAI, Voyage via the `Embedder` interface.

Disable with `CODEOID_MEMORY=0` if you don't want it.

### Parallel sessions + git worktrees

```bash
# Start two parallel features on separate worktrees, both sharing memory
bun src/cli.ts new featA --worktree feat/parser --repo /Workspace/codeoid
bun src/cli.ts new featB --worktree feat/ui     --repo /Workspace/codeoid

# In the TUI: Ctrl-G between them
```

`--worktree <branch>` spawns `<repo>.wt-<branch>` via `git worktree add` and points the session at it. The branch is created if it doesn't exist. Idempotent — re-running with the same args reuses the existing worktree.

Because `workspaceId` anchors on the shared `.git/common-dir`, both sessions live in the same workspace for memory purposes. Session A's `Read auth.ts` is available to Session B's `recall("auth flow")`.

### Execution modes

Each session has a mode. Only codeoid's internal memory-recall tools are ever
pre-approved at the SDK layer — every real tool (`Read`/`Grep`/`Glob`/`Write`/
`Edit`/`Bash`/`Agent`) is gated by the mode below:

| Mode | Behavior |
|---|---|
| `auto-allow` (default) | `Read` / `Grep` / `Glob` / memory auto-approve; `Write` / `Edit` / `Bash` / `Agent` prompt. Claude-Code-equivalent default. |
| `interactive` | Every tool call prompts for approval — including reads. |
| `autonomous` | Everything auto-approves until the write/exec budget is spent, then reverts to `auto-allow`. |

Cycle with `Shift-Tab` (or `Ctrl-M` on terminals that swallow shift-tab). Set explicitly with `/mode autonomous 100` for a 100-action budget. `/mode autonomous 0` for unbounded (use with caution).

The StatusBar shows the current mode + remaining budget; SessionTabs shows `ᴀ⚡` badge when autonomous.

### Attachments

Three ways to add file context to a turn:

**Inline `@file` mentions** (TUI):

```
› what does @src/daemon/session.ts do?
```

Tab-completes from your workspace, resolves the path, attaches the file's content to the turn. Multiple `@paths` per message work.

**`/context`** (one-shot attachments):

```
/context src/foo.ts src/bar.ts
```

Sends a minimal "review these" prompt with the files attached.

**`/pin`** (persistent across turns):

```
/pin SPEC.md
/pin acceptance-criteria.md
```

Pinned files are re-read and prepended on every turn until you `/unpin`. Pins survive daemon restart (stored in `session_pins` SQLite table). The SessionRail shows `📌N` for pinned count.

**Web UI** adds drag-drop and paste support: drop a file onto the chat area, it's read locally (up to 200 KB) and inlined as an attachment.

**Size limits** (enforced by the daemon):

- 100 KB per file, 500 KB total per turn
- Binary files (null-byte sniff) skipped with an inline error marker
- Missing files surface as `<file error="...">` so Claude sees why a path didn't resolve

### Identity chain

Every session gets a primary SPIFFE/WIMSE URI. Sub-agents (spawned via Claude's Agent tool) get their own attenuated identities. Every `tool_call` SessionMessage is stamped with the identity that made it — parent session OR sub-agent worker.

The TUI surfaces this:

- **WorkingIndicator** shows the acting agent URI + any active sub-agents
- **Tool rows from sub-agents** get a green `[name]` prefix: `[general-purpose] ✓ Read foo.ts`
- **`/who`** prints the full delegation chain:

  ```
  ## Identity chain for studio2

  You — user_xxx
    ↓
  Session agent — spiffe://highflame.ai/personal/dev/agent/codeoid-session-7838ee1d
    ↓
  ### Active sub-agents (1)
  - general-purpose (spiffe://highflame.ai/personal/dev/subagent/explorer-abc)
  ```

**Why this matters:** in audit/compliance terms, every tool call is cryptographically attributable to an exact delegated identity. Revoke the parent in ZeroID → the whole chain dies. Sub-agents get scope-attenuated tokens so they can't escalate.

### Device handoff

Detach on laptop, attach from phone. The scrollback buffer (500 entries / 1MB) replays what happened while you were away. Same session state, same memory, same pending approvals.

```
laptop$ codeoid attach oracle
> refactor the auth module
[agent working...]
Ctrl+C  # detach — session keeps running

# Later, from your phone via Telegram:
/attach oracle
# → scrollback replays → continue the conversation
```

### Context reduction stack

Three orthogonal layers, each opt-in, each carrying its weight:

**Layer C — workspace memory index** (on by default with memory enabled)

A compact markdown block auto-injected into every turn's system prompt. Contains:
- Fingerprint: `294 episodes across 8 sessions · last activity 8m ago`
- Hot files: top 10 by touch count, each with a `recall_file(path)` nudge
- Topic clusters: k-means (k ≤ 8) over episode embeddings, labeled with dominant directory + content terms (optional LLM re-labeling via Haiku when `ANTHROPIC_API_KEY` is set)
- Recent sessions: one-liner per session with its first user-turn summary
- Recall shortcuts: compact tool reference

Rebuilt on a hybrid trigger: `≥ 5 new episodes` OR `≥ 60s elapsed with ≥ 1 new episode`, debounced to max one regen per 15 s so the prompt cache stays warm. Toggle: `CODEOID_WORKSPACE_INDEX=0` disables, `CODEOID_MEMORY_CLUSTERS=1` enables the cluster section.

**Layer B — CLI output compression** (opt-in: `CODEOID_COMPRESS=1`)

A homegrown RTK-style compressor that routes Bash tool invocations through a daemon-local wrapper before Claude sees them:

- `PreToolUse` hook rewrites `Bash({ command: "git diff HEAD~5" })` → `Bash({ command: "bun …/wrapper.ts --b64 …" })`
- Wrapper runs the real command, captures stdout, applies declarative rules (`git-diff` collapses long unchanged context, `git-status` elides huge untracked-files lists, `test-runner` drops passing-test noise, `ls`/`cat`/`find`/`grep` summarize by extension/dir/file), 60–90% reduction on shell-heavy turns
- Stderr **never** compressed (error fidelity matters)
- Raw output lives in our verbatim memory store — Claude can `recall(query)` to retrieve the original bytes if the compressed version dropped something it needs

Rule format is declarative TypeScript:

```ts
export const myRule: CompressionRule = {
  name: "my-rule",
  description: "…",
  match: (cmd) => /^mything\b/.test(cmd),
  compress: (stdout, ctx) => ({ compressed, originalBytes: ctx.rawBytes, ruleName: "my-rule" }),
};
```

Drop new rules in [src/daemon/compress/rules/](src/daemon/compress/rules/) — first match wins, generic head+tail truncator is the last-resort fallback.

**Layer D — auto-rotation of the backing session** (opt-in: `CODEOID_AUTO_ROTATE=1`)

When context occupancy creeps toward Claude Code's compaction ceiling, Codeoid rolls the underlying Claude Code session to a fresh backing id while keeping codeoid's public session id stable. The user never notices — same tab, same scrollback, same memory.

Seed strategy **B: task-anchor** (current default):

- Capture the most recent user turn from memory
- Inject a `<rotation_context>` block into the first post-rotation prompt with: workspace, rotation count, last user message verbatim, reminder to call `recall` / `recall_file` / `timeline` for prior detail
- No summarization — full verbatim memory is one tool call away

Thresholds (all configurable):

| Threshold | Default | Behavior |
|---|---|---|
| `warnPct` | 60% | (Reserved for UI nudging — currently unused) |
| `rotatePct` | 80% | Auto-rotate when `enabled: true` + over `minTurnsBeforeRotate` |
| `hardRotatePct` | 90% | Rotate even when `enabled: false` (safety net) |
| `minTurnsBeforeRotate` | 3 | Prevent rotation on fresh sessions where seed would be empty |

Each rotation emits a scrollback info message, bumps the rotation counter (persisted in SQLite), and shows `🔄 N` in the StatusBar. Manual trigger via `/rotate` slash command.

### Mid-turn streaming input (VSCode parity)

Claude Code's interactive CLI is turn-based — you wait for the response before sending the next message. The SDK underneath actually supports `AsyncIterable<SDKUserMessage>` streaming, which codeoid uses for mid-turn responsiveness.

When you hit Enter on an idle session: FIFO push, business as usual. When you hit Enter on a **working** session: codeoid auto-sets `priority: "now"` — the SDK aborts Claude's in-flight response and restarts with the new context included. You pay ~1-2 s for time-to-first-token on the restart; the alternative (`priority: "next"`) gets two separate responses instead of one unified one.

Explicit control is exposed on the protocol — frontends can pass `priority: "now" | "next" | "later"` on any `session.send` message. Default is the smart auto-promotion above.

A live `⎆ N queued` badge on the StatusBar shows queue depth. Turning-point feedback: the moment you queue a mid-turn message, an info row appears immediately so you know it was received, even though Claude's reply takes a second to start flowing.

### Autonomous + stop conditions

Flip a session to autonomous mode and send it off:

```
/mode autonomous 50
› go finish the refactor; commit when tests pass
```

The session auto-approves up to 50 write/exec actions. Reads + greps + memory recall don't count against the budget (they're classified as safe). When the budget runs out, the session reverts to interactive — the next write/bash will prompt you.

Status bar shows live budget: `autonomous (37 actions left)`. You can interrupt anytime with `Ctrl-X`.

### Web UI

Mobile-first SolidJS SPA at `http://localhost:7400/ui/`. Also works as a Telegram Mini App:

- Session switcher
- Approval buttons
- File browser + drag-drop attachments
- Markdown rendering for assistant replies
- Real-time thinking display

### Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` (put them in
[`~/.codeoid/.env`](#codeoidenv--env-only-secrets) so they survive restarts),
then `bun src/cli.ts start`. Commands:

| Command | Action |
|---|---|
| `/auth <api_key>` | Authenticate with ZeroID |
| `/ls` | List sessions |
| `/new <name> <workdir>` | Create session |
| `/attach <name>` | Start receiving output |
| `/detach` | Stop receiving (session keeps running) |
| `/interrupt` | Interrupt running agent |
| `/destroy <name>` | Destroy session |
| `yes` / `no` | Approve / deny tool calls |
| _(any text)_ | Send to attached session |

While a turn is running, a one-tap **⏹ Stop** button appears on the chat —
the mobile equivalent of `Esc` / `/interrupt`.

Thinking content and sub-agent tool calls surface as separate italic messages. Streamed assistant text is buffered per message and flushed when Claude finishes (Telegram's rate limits make per-token streaming infeasible).

### Production resilience

| Pattern | What it does |
|---|---|
| **Retry with fallback model** | Exponential backoff with jitter, 429/529/5xx categorization, falls back to cheaper model after 3 capacity failures. |
| **Graceful shutdown** | LIFO cleanup registry with 30s grace. SIGTERM / SIGINT / SIGHUP handlers drain sessions before closing the store. |
| **Session resume** | JSONL transcripts per session; user prompts written BEFORE API calls. On daemon restart, sessions rebuild from transcript; `#hasQueried` flag ensures Claude Code's own session store is reused via `resume` instead of re-creating. |
| **Rate limiting** | Per-user sliding window: max 10 concurrent sessions, 30 creations/hour. |
| **Tool approval correlation** | Each approval request has a unique `approvalId`; first response wins; multiple concurrent approvals supported. |
| **Subprocess stderr capture** | Claude Code subprocess stderr is piped into the daemon log so SDK-level failures are debuggable. |
| **Keep-warm interrupt** | Interrupt (Esc / `⏹` / `Ctrl-X`) stops the in-flight turn via the SDK's `Query.interrupt()` — it reaps the running tool but keeps the backing session alive, so your next message continues on the same context. No re-`query()`, no resume handshake. Claude Code parity. |
| **Never-lose user messages** | A sent message is persisted to the transcript the instant it's accepted — before attachment resolution, rotation, or the SDK call. A failure afterward surfaces a visible `⚠️` row (never a silent drop), and frontends render send rejections instead of swallowing them. |

## Permission scopes

| Scope | Description |
|---|---|
| `session:create` | Create sessions |
| `session:destroy` | Destroy sessions |
| `session:list` | List all sessions |
| `session:attach` | Attach (full interaction) |
| `session:watch` | Watch session output (read-only) |
| `session:send` | Send messages |
| `session:interrupt` | Interrupt running agents |
| `session:approve` | Approve / deny tool requests; also required for `/mode`, `/pin`, `/unpin` |

Share a read-only token with a teammate via ZeroID:

```bash
curl -X POST http://localhost:8899/oauth2/token -d '{
  "grant_type": "token_exchange",
  "subject_token": "YOUR_TOKEN",
  "scope": "session:list session:watch"
}'
# → short-lived JWT, list + watch only, revocable anytime
```

## Configuration

### Environment variables

```bash
# Auth
CODEOID_API_KEY=zid_sk_...              # ZeroID API key (or use `codeoid login`)
ZEROID_URL=highflame                    # issuer: preset (highflame | highflame-dev | local) or URL
                                        #   default: highflame (the Highflame SaaS)
ZEROID_ISSUER=                          # expected `iss` claim; defaults to the resolved ZEROID_URL
ZEROID_ACCOUNT_ID=personal              # Enable agent identities
ZEROID_PROJECT_ID=dev

# Daemon
CODEOID_DAEMON_URL=ws://127.0.0.1:7400  # (for CLI + TUI client)
CODEOID_DB_PATH=~/.codeoid/codeoid.db   # SQLite path
CODEOID_TRANSCRIPT_DIR=~/.codeoid/transcripts

# Memory
CODEOID_MEMORY=1                        # default: on; set to 0 to disable
CODEOID_MEMORY_DB_PATH=~/.codeoid/memory.db
CODEOID_MEMORY_MODEL=Xenova/bge-small-en-v1.5   # HF model id
CODEOID_MEMORY_CACHE_DIR=~/.codeoid/models
CODEOID_MEMORY_CLUSTERS=0               # k-means topic clusters in workspace index

# Workspace index (always-in-context memory pointer)
CODEOID_WORKSPACE_INDEX=1               # auto-injected into system prompt
CODEOID_WORKSPACE_INDEX_EPISODE_THRESHOLD=5
CODEOID_WORKSPACE_INDEX_TIME_MS=60000
CODEOID_WORKSPACE_INDEX_DEBOUNCE_MS=15000

# CLI output compression (Layer B)
CODEOID_COMPRESS=0                      # opt-in: rewrites Bash output via rules
CODEOID_COMPRESS_EXCLUDE=                # comma-separated cmd prefixes to skip
CODEOID_COMPRESS_PIPES=0                 # allow compressing piped commands
CODEOID_COMPRESS_MIN_BYTES=1024          # skip compression below this size

# Auto-rotation (Layer D)
CODEOID_AUTO_ROTATE=0                   # auto-rotate backing session near context ceiling
CODEOID_AUTO_ROTATE_PCT=0.8              # rotate at this occupancy (when enabled)
CODEOID_AUTO_ROTATE_HARD_PCT=0.9         # hard-rotate even when disabled
CODEOID_AUTO_ROTATE_MIN_TURNS=3          # skip rotation on fresh sessions

# Anthropic (optional, for Haiku cluster labeling)
ANTHROPIC_API_KEY=sk-ant-...            # if set, clusters get LLM-quality labels

# OAuth (web UI PKCE)
CODEOID_HMAC_SECRET=...                 # enables OAuth authorization server
GOOGLE_CLIENT_ID=...                    # optional: Google IdP
GOOGLE_CLIENT_SECRET=...

# Telegram frontend
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123,456
```

### Config file

Optional `~/.codeoid/config.json` (env vars take precedence):

```json
{
  "daemonUrl": "ws://127.0.0.1:7400",
  "zeroidUrl": "highflame",
  "apiKey": "zid_sk_...",
  "agentIdentity": {
    "accountId": "personal",
    "projectId": "dev"
  },
  "memory": {
    "enabled": true,
    "dbPath": "~/.codeoid/memory.db",
    "model": "Xenova/bge-small-en-v1.5"
  }
}
```

### `~/.codeoid/.env` — env-only secrets

Some daemon settings are env-only (notably the Telegram frontend). Rather than
exporting them in whatever shell happens to launch the daemon — where a restart
from a different terminal silently drops them — put them in `~/.codeoid/.env`.
`codeoid start` loads this file before anything reads `process.env`, it's
co-located with `config.json` (cwd-independent), mode `600`, and never in git.
A variable already set in the real environment still wins.

```bash
# ~/.codeoid/.env
TELEGRAM_BOT_TOKEN=123456:AA...
TELEGRAM_ALLOWED_USER_IDS=6714605885
# ANTHROPIC_API_KEY=          # only if not logged in via `claude login`
```

## CLI reference

```bash
bun src/cli.ts start [--port 7400] [--host 127.0.0.1] [--no-telegram] [--no-web]

bun src/cli.ts tui                                   # Launch the cockpit TUI
bun src/cli.ts ls                                    # List sessions
bun src/cli.ts new <name> [workdir]                  # Create session
  --worktree <branch>                                #   auto-spawn a git worktree
  --repo <path>                                      #   worktree source (default: cwd)
  --worktree-dir <path>                              #   override target dir
bun src/cli.ts attach <session>                      # Readline streaming attach
bun src/cli.ts send <session> <message...>           # One-shot send
bun src/cli.ts interrupt <session>                   # Interrupt
bun src/cli.ts approve <session> [--deny]            # Approve / deny pending tool
bun src/cli.ts destroy <session>                     # Destroy
```

## Development

```bash
bun install              # install deps
bun run dev              # run daemon with --watch
bun run build            # build to dist/
bun run typecheck        # type check
bun run lint             # lint with biome
bun test                 # run unit tests (memory, attachments, etc.)
```

### Key files

| Area | File |
|---|---|
| CLI + command routing | [src/cli.ts](src/cli.ts) |
| Daemon HTTP + WebSocket | [src/daemon/server.ts](src/daemon/server.ts) |
| Session orchestration | [src/daemon/session-manager.ts](src/daemon/session-manager.ts), [src/daemon/session.ts](src/daemon/session.ts) |
| Memory engine | [src/daemon/memory/](src/daemon/memory/) |
| Attachments + limits | [src/daemon/attachments.ts](src/daemon/attachments.ts) |
| Git worktree helper | [src/worktree.ts](src/worktree.ts) |
| Web UI server (serves `web/dist` at `/ui`) | [src/frontends/web-ui/index.ts](src/frontends/web-ui/index.ts) |
| Web UI app (SolidJS) | [web/](web/) |
| Telegram bot | [src/frontends/telegram/index.ts](src/frontends/telegram/index.ts) |
| Built-in TUI (Ink, legacy fallback) | [src/tui/](src/tui/) |
| Native TUI (Rust, recommended) | [saucam/codeoid-ui](https://github.com/saucam/codeoid-ui) |
| Protocol types | [src/protocol/types.ts](src/protocol/types.ts) |

## Contributing & security

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For vulnerabilities, see
[SECURITY.md](SECURITY.md) (please don't open public issues for security).

## License

[MIT](LICENSE) © Codeoid

---

Powered by [ZeroID](https://github.com/highflame-ai/zeroid) + [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Terminal cockpit: [codeoid-tui](https://github.com/saucam/codeoid-ui).
