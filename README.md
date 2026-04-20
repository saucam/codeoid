# Codeoid

**Identity-first control plane for AI coding agents — multi-session, multi-frontend, with cross-session memory.**

Run N parallel Claude Code sessions across repos. Switch between them from a terminal cockpit, a web UI, or Telegram. Every action auditable; every agent (and sub-agent) has a cryptographic identity via [ZeroID](https://github.com/highflame-ai/zeroid). Memory persists across sessions so Claude inherits what it learned last time.

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
- **Autonomous runs with a budget** — Flip a session to autonomous mode; it auto-approves safe operations until a write/exec budget is spent, then hands control back.
- **Device handoff** — Start a session on your laptop, attach from your phone. Scrollback replays. Same conversation.
- **Identity-grade audit** — Every tool call stamped with the SPIFFE URI of the agent that made it. Sub-agents get their own attenuated identities. Delegation chain traceable top to bottom.
- **Multi-frontend** — same session accessible from terminal TUI, browser, or Telegram bot. Share read-only tokens with a teammate.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- [ZeroID](https://github.com/highflame-ai/zeroid) running locally
- Claude Code CLI logged in (`claude login`) or `ANTHROPIC_API_KEY` set

### Install

```bash
git clone https://github.com/highflame-ai/codeoid.git
cd codeoid
bun install
```

### Setup ZeroID

Register a Codeoid agent in ZeroID and save the returned `api_key`:

```bash
curl -X POST http://localhost:8899/api/v1/agents/register \
  -H "Content-Type: application/json" \
  -H "X-Account-ID: personal" \
  -H "X-Project-ID: dev" \
  -H "X-User-ID: $USER" \
  -d '{
    "name": "my-codeoid",
    "external_id": "codeoid-1",
    "sub_type": "autonomous"
  }'
```

### Run

```bash
export CODEOID_API_KEY="zid_sk_..."
export ZEROID_URL="http://localhost:8899"

# Start the daemon — serves TUI/web/Telegram + mounts memory
bun src/cli.ts start
```

Then open the TUI in another terminal:

```bash
bun src/cli.ts tui
```

Or browse to http://localhost:7400/app for the web UI.

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
│   │   sub-agent      │       │  - Web UI (SPA at /app)        │     │
│   │   tokens         │       │  - Telegram (grammy)           │     │
│   └──────────────────┘       └────────────────────────────────┘     │
│          │                                                           │
│          ▼                                                           │
│       ZeroID                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

Sessions are daemon-owned. Clients are stateless; they attach, receive scrollback replay, and stream live deltas. Detach and re-attach from anywhere.

## Features

### Terminal cockpit (TUI)

`bun src/cli.ts tui` launches an Ink-based cockpit with everything in one view:

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

Each session has a mode:

| Mode | Behavior |
|---|---|
| `interactive` (default) | Every tool call prompts for approval |
| `auto-allow` | `Read` / `Grep` / `Glob` / memory tools auto-approve; `Write` / `Edit` / `Bash` still prompt |
| `autonomous` | Everything auto-approves until the write/exec budget is spent, then reverts to `interactive` |

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

### Autonomous + stop conditions

Flip a session to autonomous mode and send it off:

```
/mode autonomous 50
› go finish the refactor; commit when tests pass
```

The session auto-approves up to 50 write/exec actions. Reads + greps + memory recall don't count against the budget (they're classified as safe). When the budget runs out, the session reverts to interactive — the next write/bash will prompt you.

Status bar shows live budget: `autonomous (37 actions left)`. You can interrupt anytime with `Ctrl-X`.

### Web UI

Mobile-first SPA at `http://localhost:7400/app`. Also works as a Telegram Mini App:

- Session switcher
- Approval buttons
- File browser + drag-drop attachments
- Markdown rendering for assistant replies
- Real-time thinking display

### Telegram

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS`, then `bun src/cli.ts start`. Commands:

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
CODEOID_API_KEY=zid_sk_...              # ZeroID API key (required)
ZEROID_URL=http://localhost:8899        # ZeroID server URL
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
  "zeroidUrl": "http://localhost:8899",
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
| TUI (Ink) | [src/tui/](src/tui/) |
| Web UI | [src/frontends/web/index.ts](src/frontends/web/index.ts) |
| Telegram bot | [src/frontends/telegram/index.ts](src/frontends/telegram/index.ts) |
| Protocol types | [src/protocol/types.ts](src/protocol/types.ts) |

## License

MIT

---

Built by [Highflame](https://highflame.ai). Powered by [ZeroID](https://github.com/highflame-ai/zeroid) + [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) + [Ink](https://github.com/vadimdemedes/ink).
