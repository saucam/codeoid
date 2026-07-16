# Codeoid

[![npm version](https://img.shields.io/npm/v/codeoid?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/codeoid)
[![npm downloads](https://img.shields.io/npm/dm/codeoid?logo=npm&label=downloads&color=cb3837)](https://www.npmjs.com/package/codeoid)
[![CI](https://github.com/saucam/codeoid/actions/workflows/ci.yml/badge.svg)](https://github.com/saucam/codeoid/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/saucam/codeoid/branch/main/graph/badge.svg)](https://codecov.io/gh/saucam/codeoid)
[![published with provenance](https://img.shields.io/badge/published%20with-provenance-2da44e?logo=npm)](https://www.npmjs.com/package/codeoid)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000000.svg?logo=bun)](https://bun.sh)

**Identity-first control plane for AI coding agents — multi-session, multi-frontend, with cross-session memory.**

Run N parallel coding-agent sessions across repos — Claude Code by default, with Codex, Gemini, OpenAI, and pi as drop-in backends. Switch between them from a terminal cockpit, a web UI, or Telegram. Every action auditable; every agent (and sub-agent) has a cryptographic identity via [ZeroID](https://github.com/highflame-ai/zeroid). Memory persists across sessions, so each agent inherits what the last one learned.

> **Terminal client lives in its own repo.** The recommended cockpit is [**codeoid-tui**](https://github.com/saucam/codeoid-ui) — a native Rust/[Ratatui](https://ratatui.rs) client that speaks the daemon's WebSocket protocol. A built-in `codeoid tui` (Ink/React) ships in this repo as a zero-install fallback. See [Terminal client](docs/FEATURES.md#terminal-client).

<p align="center">
  <img src="docs/screenshots/tui.webp" width="860"
       alt="codeoid-ui, the Rust/Ratatui terminal cockpit: a top tab bar of 12 running sessions with the active one boxed, a live session log in the center, a usage and cost readout on the right, a prompt box, and a keybinding bar along the bottom.">
</p>
<p align="center">
  <sub><b>codeoid-tui</b>, the native Rust cockpit, tracking 12 parallel sessions at once. The same sessions open in a <a href="#interfaces">browser and on Telegram</a> — one daemon, one source of truth.</sub>
</p>

## Contents

- [Why Codeoid](#why-codeoid)
- [How Codeoid compares](#how-codeoid-compares)
- [Quick start](#quick-start)
- [Backends](#backends)
- [Architecture](#architecture)
- [Features](#features)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Development](#development)
- [Contributing & security](#contributing--security)

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

Codeoid isn't a general-purpose IDE assistant. It's built for **long-horizon, multi-session agent work**, where context continuity and token economics matter more than inline code actions — so it optimizes for what the tools you already use don't: verbatim cross-session memory, parallel sessions on one control plane, a cryptographic identity per agent and sub-agent, and per-turn token economics.

Its closest peer is **[Omnigent](https://github.com/omnigent-ai/omnigent)**, another multi-harness meta-harness — both run Claude, Codex, Gemini, OpenAI, and pi. They optimize for different things. Omnigent leans on **breadth and isolation**: the widest harness set (incl. Cursor, OpenCode, Hermes), an OS-level sandbox, and credential brokering. Codeoid leans on **memory and identity**: workspace-scoped verbatim recall, a cryptographic identity per agent and sub-agent (ZeroID), and per-turn token economics — reachable from a terminal, a browser, or your phone. Rule of thumb: reach for Omnigent when you need OS-level isolation and the broadest harness set; reach for Codeoid when you want persistent cross-session memory and per-agent audit for long-horizon work.

📊 **[Full capability matrix →](docs/COMPARISON.md)** — feature by feature against Claude Code CLI, the VSCode extension, Cursor, Aider, and Omnigent.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- Claude Code CLI logged in (`claude login`) or `ANTHROPIC_API_KEY` set — the default backend. Other backends (Codex, Gemini CLI, pi, OpenAI, Gemini) are optional — see [Backends](#backends) for each one's setup.
- A ZeroID identity — either the hosted Highflame SaaS (no infra) or a [self-hosted ZeroID](https://github.com/highflame-ai/zeroid)

### Install

**From npm (recommended)** — Codeoid runs on Bun, so install it with Bun (`npm` also works as long as Bun is on your `PATH`, since it's the runtime):

```bash
bun install -g codeoid        # or: npm install -g codeoid
```

This puts a `codeoid` command on your `PATH`. Everywhere below you can run `codeoid <cmd>` directly — e.g. `codeoid login`, `codeoid start`, `codeoid tui`.

**From source** — to hack on it:

```bash
git clone https://github.com/saucam/codeoid.git
cd codeoid
bun install
```

From a source checkout, run `bun src/cli.ts <cmd>` in place of `codeoid <cmd>` below.

### Authenticate

Codeoid needs one thing to start: a ZeroID key. Two ways to get one.

**Option A — Highflame SaaS (recommended, no infra)**

1. Sign up at [highflame.ai](https://highflame.ai) and open Studio → **Code Agents**.
2. Create a key (you'll get a `zid_sk_...`).
3. Log in — Codeoid ships pointing at the Highflame SaaS issuer, so there's nothing else to configure:

   ```bash
   bun src/cli.ts login          # prompts for the key (hidden), verifies it, saves to ~/.codeoid/config.json
   ```

**Option B — Self-hosted ZeroID (local, ~2 min)**

[ZeroID](https://github.com/highflame-ai/zeroid) is open source. Bring it up locally with Docker, then mint a key and point Codeoid at it:

```bash
# 1. Run ZeroID (Postgres + issuer on :8899)
git clone https://github.com/highflame-ai/zeroid && cd zeroid
make setup-keys              # generate the ECDSA/RSA signing keys
docker compose up -d         # starts Postgres + ZeroID
curl http://localhost:8899/health     # → {"status":"healthy",...}

# 2. Register an agent to mint a key (zid_sk_…) — shown once.
#    Use the ZeroID SDK / API (see the ZeroID repo's quickstart), e.g.
#    client.agents.register(name="codeoid", created_by="you@example.com")

# 3. Point Codeoid at your local issuer and log in with that key.
cd ../codeoid
bun src/cli.ts login --zeroid local                       # localhost:8899
# ...or any deployment:
bun src/cli.ts login --zeroid https://zeroid.mycorp.com
```

`--zeroid` accepts a preset (`highflame`, `highflame-dev`, `local`) or any URL. The issuer is pinned to whatever you log in against — a token minted by any other issuer is rejected. `login` exchanges the key on the spot and prints the subject + granted scopes so you know it works before the daemon ever starts.

> The daemon fetches the issuer's JWKS to verify tokens, so wherever ZeroID runs must be reachable from the daemon.

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

## Backends

**Claude is the default and always available.** Every other backend is opt-in and auto-detected:

- **CLI backends** (`codex`, `gemini-cli`, `pi`) authenticate with **their own login** — your existing Codex / Google / pi subscription — so Codeoid needs no API key for them. `gemini-cli` and `pi` ship **bundled** with Codeoid (no separate install), so you only have to log into them once; `codex` you install yourself.
- **In-daemon API backends** (`openai`, `gemini`) register only when their **API key** is set in `~/.codeoid/.env`. These bill against the key, not a subscription.

Pick a backend per session with `codeoid new <name> --provider <id>`, or switch a live session with `/provider <id>`. Set keys from the Settings screen (⚙ / `/settings`) or by editing `~/.codeoid/.env` — see [Configuration](docs/CONFIGURATION.md) for every variable.

> **Subscription vs. API key (important for Gemini):** there are **two** Gemini backends. `gemini-cli` uses the Gemini CLI's Google login, so it rides your **Google AI Pro/Ultra subscription with no key**. The in-daemon `gemini` backend talks to the public Gemini API, which is **API-key only** (billed against the key, not your subscription). Want to use your Ultra plan? Use **gemini-cli**, not `gemini`.

<details>
<summary><b>Claude</b> — default, always on (Anthropic)</summary>

Nothing to install — it runs in-process via the Claude Agent SDK. Just authenticate one of two ways:

- **Subscription:** `claude login` (uses your Claude/Anthropic plan), or
- **API key:** put `ANTHROPIC_API_KEY=sk-ant-…` in `~/.codeoid/.env`.
- **Amazon Bedrock:** set `CLAUDE_CODE_USE_BEDROCK=1`. AWS credentials aren't forwarded to the backend by default — allow them through with `CODEOID_AGENT_ENV_ALLOW=AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY,AWS_SESSION_TOKEN`.

Models: the aliases `opus` / `sonnet` / `haiku`, or any full `claude-*` id (`codeoid new work --provider claude`, then `/model opus`).
</details>

<details>
<summary><b>Gemini CLI</b> (<code>gemini-cli</code>) — your Google subscription, no API key</summary>

This is the backend to use if you pay for **Google AI Pro/Ultra** and don't want to use an API key.

1. **Log in once** with the Gemini CLI so it stores your Google OAuth credentials in `~/.gemini`: install it (`npm i -g @google/gemini-cli`, or `npx @google/gemini-cli`), run `gemini`, and choose **"Login with Google"** with your AI Pro/Ultra account. No key needed. (You *can* instead set `GEMINI_API_KEY` or Vertex env.)
2. That's it — Codeoid **bundles the Gemini CLI**, so at runtime it uses `gemini` from your `PATH` if present, otherwise its own bundled copy. Nothing else to install for Codeoid's sake.

Override the binary with `providers.geminiCli.command`, or disable it with `providers.geminiCli.enabled: false` in `config.json`. Driven over ACP (`gemini --acp`).

> ⚠️ If you *also* set `GOOGLE_API_KEY` / `GEMINI_API_KEY` (for the in-daemon `gemini` backend), the CLI may prefer key auth over your Google login. Leave those unset to ride the subscription.
</details>

<details>
<summary><b>Codex</b> (<code>codex</code>) — OpenAI Codex CLI</summary>

1. Install the **OpenAI Codex CLI** (`npm i -g @openai/codex`) — unlike gemini-cli/pi it is **not** bundled, so `codex` must be on your `PATH` (or point `providers.codex.command` at it).
2. Authenticate with `codex login` (stored in `~/.codex/auth.json`) — uses your OpenAI/Codex plan — or provide `OPENAI_API_KEY` in the environment.
3. Codeoid auto-detects `codex` (your `PATH` plus common Node bin dirs) and drives it over `codex app-server`.

Override with `providers.codex.command`, disable with `providers.codex.enabled: false`. Codex's native approval/sandbox default is derived from the session **mode**; pin it with `CODEX_APPROVAL_POLICY` (`untrusted` / `on-request` / `never`) and `CODEX_SANDBOX_POLICY` (`read-only` / `workspace-write` / `danger-full-access`).
</details>

<details>
<summary><b>pi</b> (<code>pi</code>) — the pi coding agent</summary>

1. **Log in once** with the pi CLI so it stores credentials in `~/.pi/agent/auth.json`.
2. That's it — Codeoid **bundles pi**, so at runtime it uses `pi` from your `PATH` if present, otherwise its bundled copy, driven over `pi --mode rpc`.

Override with `providers.pi.command`, disable with `providers.pi.enabled: false`. `PI_CONFIG_DIR` relocates pi's config/credential directory.
</details>

<details>
<summary><b>OpenAI</b> (<code>openai</code>) — API key</summary>

An in-daemon backend that talks to the OpenAI API. Set `OPENAI_API_KEY=sk-…` in `~/.codeoid/.env` (or via the Settings screen). The backend registers only when the key is present. Billed against the key.
</details>

<details>
<summary><b>Gemini</b> (<code>gemini</code>) — API key (not your subscription)</summary>

An in-daemon backend that talks to the public Gemini API. Set `GOOGLE_API_KEY=…` (or `GEMINI_API_KEY`) in `~/.codeoid/.env`. Registers only when the key is present, and **bills against the key, not your Google subscription**.

To use your **AI Pro/Ultra subscription** with no key, use the **`gemini-cli`** backend above instead.
</details>

## Architecture

<p align="center">
  <img src="docs/architecture.png" width="840"
       alt="Codeoid architecture: stateless clients (Terminal TUI, Web UI, Telegram) attach to one Bun daemon that owns every session — Session Manager, Memory Engine, MCP server and ZeroID client — driving a provider backend per session over SQLite memory, with a ZeroID identity stamped on every action.">
</p>
<p align="center">
  <sub>Claude is the default backend; Codex, Gemini, OpenAI, pi, and the Gemini CLI plug into the same session interface.</sub>
</p>

In one Bun process the daemon brokers everything between your clients and Claude, and owns three subsystems:

- **Session Manager** — per-session mode + write/exec budget, pinned files, the sub-agent tree, scrollback, and a JSONL transcript for crash-safe resume.
- **Memory Engine** — a chunker turns every tool call into a verbatim *episode*; a hybrid ranker (vectors + FTS5 BM25 + recency + path overlap) serves it back. Backed by SQLite (FTS5 + embeddings + file-read cache) and exposed to Claude as an **in-process MCP server** — `recall()`, `recall_file()`, `timeline()`.
- **ZeroID client** — registers the session's SPIFFE identity and mints attenuated tokens for each sub-agent.

Each session drives its own provider backend — the **Claude Agent SDK** by default, or Codex, Gemini, OpenAI, pi, or the Gemini CLI, all behind one `SessionProvider` interface (adding a backend is one factory + one `register()`). The diagram above shows how the pieces fit.

Sessions are daemon-owned. Clients are stateless; they attach, receive scrollback replay, and stream live deltas. Detach and re-attach from anywhere.

## Features

Full detail — keybindings, slash commands, ranking weights, rotation thresholds — lives in **[docs/FEATURES.md](docs/FEATURES.md)**. The highlights:

**Memory & context**

- **[Cross-session memory](docs/FEATURES.md#cross-session-memory)** — every tool call, result, and reasoning block is stored verbatim as a retrievable *episode*, served back by a hybrid ranker (vectors + FTS5 + recency + path overlap). Claude gets `recall()`, `recall_file()`, and `timeline()`.
- **[Workspace memory index](docs/FEATURES.md#context-reduction-stack)** — a compact hot-files + topic-clusters + recent-sessions block auto-injected into every system prompt, so a fresh session starts already oriented.
- **[Three-layer context reduction](docs/FEATURES.md#context-reduction-stack)** — pre-entry CLI-output compression, backing-context auto-rotation, and verbatim recall. All lossless: recall returns the original bytes.

**Sessions & control**

- **[Multiple harnesses](docs/FEATURES.md#harnesses)** — Claude Code by default; Codex, Gemini, OpenAI, pi, and the Gemini CLI drop in behind one provider interface. Fork a session onto a different backend and it resumes with the full conversation.
- **[Parallel sessions + git worktrees](docs/FEATURES.md#parallel-sessions--git-worktrees)** — run features side by side; branches share one workspace memory, anchored on `git-common-dir`.
- **[Execution modes](docs/FEATURES.md#execution-modes)** — `guarded` / `interactive` / `autonomous`, the last with a write-action budget that reverts to guarded when spent.
- **[Mid-turn streaming input](docs/FEATURES.md#mid-turn-streaming-input-vscode-parity)** — send a follow-up while Claude is still responding; `now` / `next` / `later` priority.
- **[Attachments](docs/FEATURES.md#attachments)** — `@file` mentions, one-shot `/context`, and persistent `/pin`; drag-drop in the web UI.

**Identity & resilience**

- **[Cryptographic identity per agent + sub-agent](docs/FEATURES.md#identity-chain)** — ZeroID SPIFFE/WIMSE URIs stamped on every tool call; `/who` prints the full delegation chain, and revoking the parent kills it.
- **[Production resilience](docs/FEATURES.md#production-resilience)** — retry-with-fallback, graceful shutdown, transcript-based resume, rate limiting, keep-warm interrupt, and never-lose-message persistence.

### Interfaces

One daemon, one source of truth, three ways in: the [terminal cockpit](docs/FEATURES.md#terminal-client) (shown at the top), a browser, and Telegram. [Device handoff](docs/FEATURES.md#device-handoff) lets you start on one and pick the session up on another — scrollback replays.

<p align="center">
  <img src="docs/screenshots/web-ui.webp" width="820"
       alt="Codeoid web UI in a browser: a session list down the left, the live log of the active session in the center, and a metrics bar across the top showing turns, tokens, cache reads, and cumulative cost.">
</p>
<p align="center">
  <sub>The SolidJS web UI at <code>localhost:7400/ui</code> — session list on the left, live log in the center, a metrics strip on top (turns, tokens, cache reads, cumulative cost).</sub>
</p>

<p align="center">
  <img src="docs/screenshots/telegram.webp" width="360"
       alt="Codeoid Telegram mini app on a phone showing a live session log, a header with uptime, context occupancy, and cost, and a command input at the bottom.">
</p>
<p align="center">
  <sub>The same session on a phone, in the Telegram mini app — identical scrollback, a live header, served by the bot over the same WebSocket.</sub>
</p>

Full keybindings, slash commands, and the Telegram command set → **[docs/FEATURES.md](docs/FEATURES.md#terminal-client)**.

## Configuration

Codeoid reads `~/.codeoid/config.json` and environment variables; env-only secrets (like the Telegram bot token) live in `~/.codeoid/.env` so they survive daemon restarts. Every client action is gated by a ZeroID permission scope, and scopes attenuate into revocable read-only share tokens for teammates.

→ **[Configuration & permission scopes](docs/CONFIGURATION.md)** — every environment variable, the `config.json` schema, the `~/.codeoid/.env` file, and the full scope list.

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

Powered by [ZeroID](https://github.com/highflame-ai/zeroid) with pluggable agent backends (default [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)). Terminal cockpit: [codeoid-tui](https://github.com/saucam/codeoid-ui).
