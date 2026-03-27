# Codeoid

Identity-first remote control plane for AI coding agents. Powered by ZeroID.

## Architecture

```
src/
├── cli.ts                 # Entry point — commander-based CLI
├── config.ts              # Config loader (~/.codeoid/config.json + env vars)
├── daemon/
│   ├── server.ts          # WebSocket server + HTTP health check
│   ├── session-manager.ts # Orchestrates N concurrent sessions
│   ├── session.ts         # Wraps Claude Agent SDK per session
│   ├── store.ts           # SQLite persistence (metadata + audit log)
│   └── auth.ts            # ZeroID JWT verification via @highflame/sdk
├── protocol/
│   ├── types.ts           # Client↔Daemon message types
│   └── scopes.ts          # Codeoid permission scopes
├── terminal/
│   └── client.ts          # Terminal client (WebSocket → stdin/stdout)
└── telegram/
    └── bot.ts             # Grammy Telegram bot client
```

## Core Concepts

### Sessions
A session = one Claude Agent SDK process working in one directory.
Sessions are named, persistent, and independent. Multiple clients can
attach/detach from the same session simultaneously.

### Auth Model
Every connection requires a ZeroID JWT. Scopes are enforced per-message:
- `session:create` / `session:destroy` — lifecycle
- `session:attach` / `session:watch` — connect to sessions
- `session:send` / `session:interrupt` / `session:approve` — interact

### Device Handoff
Sessions live in the daemon. Clients (terminal, Telegram) are stateless
WebSocket connections. Detach from terminal → attach from Telegram →
same session, same context, no state loss.

## Tech Stack
- TypeScript, Node 22+
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- ZeroID auth (`@highflame/sdk`)
- WebSocket (`ws`), SQLite (`better-sqlite3`), Telegram (`grammy`)
- CLI: `commander`

## Code Patterns

### Async/Error Handling
- All I/O is async
- Agent errors are caught and broadcast to attached clients, never crash the daemon
- Permission requests are surfaced to clients and awaited

### Security
- ZeroID JWT verified on every connection (local JWKS, no round-trip)
- Scopes enforced per-message in SessionManager
- Telegram user ID allowlist as first gate, ZeroID as second
- API keys deleted from Telegram chat on /auth
- Audit log: every action attributed to a ZeroID subject

### Testing
```bash
npm run typecheck    # Type check
npm run lint         # Biome
npm run build        # tsup
```

## Config

```bash
# Environment variables
CODEOID_DAEMON_URL=ws://127.0.0.1:7400
CODEOID_DB_PATH=~/.codeoid/codeoid.db
CODEOID_API_KEY=zid_sk_...
ZEROID_URL=http://localhost:8899
ZEROID_JWKS_URL=http://localhost:8899/.well-known/jwks.json

# Telegram bot
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123456,789012
```
