# Codeoid

**Identity-first remote control plane for AI coding agents.**

Control your Claude Code sessions from your phone, laptop, or any device. Every connection verified by [ZeroID](https://github.com/highflame-ai/zeroid). Every action auditable.

```
Phone (Telegram / Web UI)  ──┐
                              ├──▶  Codeoid Daemon (Bun)  ──▶  Claude Agent SDK
Laptop (Terminal)           ──┘         │
                                   ZeroID (auth)
```

## Why Codeoid?

You're working with AI coding agents. You start a session on your laptop, walk away, and want to check progress from your phone. Or you want your teammate to watch the agent's output without giving them full control. Or you want to run 5 agent sessions in parallel across different repos.

Existing tools are single-user, single-device, no auth. Codeoid is:

- **Multi-session** — N agents working in parallel, each in their own repo
- **Multi-device** — seamlessly switch between terminal, web UI, Telegram
- **Multi-user** — scoped tokens with read-only watchers, full operators, etc.
- **Auditable** — every action attributed to a ZeroID identity in SQLite
- **Resilient** — sessions survive daemon restarts, retry with fallback models

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [ZeroID](https://github.com/highflame-ai/zeroid) running locally (for auth)
- Claude Code CLI logged in (`claude login`) or `ANTHROPIC_API_KEY` set

### Install

```bash
git clone https://github.com/highflame-ai/codeoid.git
cd codeoid
bun install
```

### Setup ZeroID

Register a Codeoid agent:

```bash
curl -X POST http://localhost:8899/api/v1/agents/register \
  -H "Content-Type: application/json" \
  -H "X-Account-ID: personal" \
  -H "X-Project-ID: dev" \
  -d '{
    "name": "my-codeoid",
    "external_id": "codeoid-1",
    "sub_type": "orchestrator",
    "trust_level": "first_party",
    "created_by": "your-username"
  }'
```

Save the `api_key` from the response.

### Run

```bash
export CODEOID_API_KEY="zid_sk_..."
export ZEROID_URL="http://localhost:8899"

# Start the daemon
codeoid start

# In another terminal:
codeoid new oracle /path/to/your/repo
codeoid attach oracle
> review the webhook handler for security issues
```

## How It Works

```
┌──────────────┐        ┌───────────────────────────────┐
│  Telegram     │─JWT──▶│                               │
│  (phone)      │◀──────│     Codeoid Daemon (Bun)      │       ┌─────────┐
└──────────────┘        │                               │──────▶│ ZeroID  │
                        │  Sessions:                    │◀──────│ (JWKS)  │
┌──────────────┐        │  ┌──────────────────────────┐ │       └─────────┘
│  Terminal     │─JWT──▶│  │ oracle  → Agent SDK      │ │
│  (laptop)     │◀──────│  │ shield  → Agent SDK      │ │
└──────────────┘        │  │ core    → Agent SDK      │ │
                        │  └──────────────────────────┘ │
┌──────────────┐        │                               │
│  Web UI       │─JWT──▶│  SQLite (sessions, audit)     │
│  (any device) │◀──────│  JSONL (transcripts)          │
└──────────────┘        └───────────────────────────────┘
```

Sessions are daemon-owned. Clients are stateless. Attach from terminal, detach, attach from Telegram — same session, same context, scrollback replayed.

## Features

### Device Handoff

Detach on laptop, attach from phone. The scrollback buffer (500 entries / 1MB) replays what happened while you were away.

```
laptop$ codeoid attach oracle
> refactor the auth module
[agent working...]
Ctrl+C  # detach

# Later, from your phone (Telegram):
/attach oracle
# → scrollback: "Here's what I changed in auth.ts..."
# → continue the conversation
```

### Parallel Sessions

```bash
codeoid new oracle /Workspace/highflame-oracle
codeoid new shield /Workspace/highflame-shield
codeoid new core   /Workspace/highflame-core

codeoid ls
# oracle    idle     /Workspace/highflame-oracle
# shield    working  /Workspace/highflame-shield
# core      idle     /Workspace/highflame-core
```

### Scoped Access

Share a read-only token with your teammate:

```bash
# Issue a watcher-only token via ZeroID
curl -X POST http://localhost:8899/oauth2/token \
  -d '{"grant_type": "token_exchange", "subject_token": "YOUR_TOKEN", "scope": "session:list session:watch"}'
# → Short-lived JWT with only list + watch permissions
# → Share with teammate, revoke anytime
```

### Agent Identities

When configured (`ZEROID_ACCOUNT_ID`), Claude agents and sub-agents get ZeroID identities:

```
You (spiffe://zeroid.dev/personal/dev/human/ydatta)
  └── Session "oracle" (spiffe://zeroid.dev/personal/dev/agent/codeoid-session-abc)
       ├── scopes: [tools:read, tools:write, tools:execute, tools:agent]
       └── Sub-agent "explore" (spiffe://zeroid.dev/personal/dev/agent/codeoid-explore-def)
            └── scopes: [tools:read]  ← attenuated, can only read
```

Every tool call audited. Delegation chain traceable. Revoke parent → entire chain dies.

### Production Resilience

| Pattern | What it does |
|---|---|
| **Retry with fallback** | Exponential backoff with jitter, error categorization (429/529/5xx), capacity limit → fallback model, unattended mode with 5min max backoff |
| **Graceful shutdown** | Cleanup registry (LIFO), 30s grace period, SIGTERM/SIGINT/SIGHUP handlers |
| **Session resume** | JSONL transcripts per session, user prompts persisted before API calls, sessions rebuilt on daemon restart |
| **Rate limiting** | Per-user concurrent session limits (10) and hourly creation rate (30/hr) |
| **Permission correlation** | Each approval request has a unique `approvalId`, first response wins, multiple concurrent approvals supported |
| **Scrollback buffer** | Circular ring (500 entries / 1MB), replayed on device handoff |

### Web UI

Mobile-first SPA served at `http://localhost:7400/app`. Also works as a Telegram Mini App.

- Session switcher
- Approval buttons (not text "yes/no")
- File browser with tap-to-add-context
- Voice input

### Telegram Bot

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS`, then `codeoid start`:

```
/ls                              — list sessions
/new oracle /path/to/repo        — create session
/attach oracle                   — start receiving output
/detach                          — stop receiving, session keeps running
yes / no                         — approve/deny tool calls
/interrupt                       — interrupt running agent
/destroy oracle                  — destroy session
```

## Permission Scopes

| Scope | Description |
|---|---|
| `session:create` | Create new sessions |
| `session:destroy` | Destroy sessions |
| `session:list` | List all sessions |
| `session:attach` | Attach to sessions (full interaction) |
| `session:watch` | Watch session output (read-only) |
| `session:send` | Send messages to agents |
| `session:interrupt` | Interrupt running agents |
| `session:approve` | Approve/deny tool permission requests |

## Configuration

### Environment Variables

```bash
CODEOID_API_KEY=zid_sk_...           # ZeroID API key (required)
ZEROID_URL=http://localhost:8899     # ZeroID server URL
CODEOID_DAEMON_URL=ws://127.0.0.1:7400  # Daemon URL (for CLI client)
CODEOID_DB_PATH=~/.codeoid/codeoid.db   # SQLite path
CODEOID_TRANSCRIPT_DIR=~/.codeoid/transcripts  # JSONL path
ZEROID_ACCOUNT_ID=personal           # Enable agent identities
ZEROID_PROJECT_ID=dev
TELEGRAM_BOT_TOKEN=...              # Enable Telegram frontend
TELEGRAM_ALLOWED_USER_IDS=123,456   # Telegram user allowlist
```

### Config File

Optional `~/.codeoid/config.json`:

```json
{
  "daemonUrl": "ws://127.0.0.1:7400",
  "zeroidUrl": "http://localhost:8899",
  "apiKey": "zid_sk_...",
  "agentIdentity": {
    "accountId": "personal",
    "projectId": "dev"
  }
}
```

Environment variables take precedence over config file.

## Development

```bash
bun install              # install dependencies
bun run dev              # run from source with --watch
bun run build            # build to dist/
bun run typecheck        # type check
bun run lint             # lint with biome
```

## License

MIT

---

Built by [Highflame](https://highflame.ai). Powered by [ZeroID](https://github.com/highflame-ai/zeroid).
