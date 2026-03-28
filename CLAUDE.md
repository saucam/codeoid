# Codeoid

Identity-first remote control plane for AI coding agents. Powered by ZeroID.

## Architecture

```
codeoid start
  ├── Daemon (WebSocket server + HTTP server + SQLite)
  ├── Web UI frontend (served at /app, also Telegram Mini App)
  ├── Telegram frontend (embedded, direct SessionManager access)
  └── SessionManager → Claude Agent SDK × N sessions
```

### Plugin Architecture

Frontends implement the `Frontend` interface and get direct access to the
SessionManager — no network hop for embedded frontends.

```typescript
interface Frontend {
  readonly name: string;
  start(ctx: FrontendContext): Promise<void>;
  stop(): Promise<void>;
}

interface FrontendContext {
  manager: SessionManager;   // direct access
  store: Store;              // audit log
  auth: AuthConfig;          // ZeroID config
  httpServer: Server;        // mount custom routes
  host: string; port: number;
}
```

Register with `daemon.use(new MyFrontend())` — that's it.

### File Structure

```
src/
├── cli.ts                      # CLI entry: start, ls, new, attach, send, etc.
├── config.ts                   # Config: ~/.codeoid/config.json + env vars
├── daemon/
│   ├── server.ts               # WebSocket + HTTP server, frontend plugin host
│   ├── session-manager.ts      # Orchestrates N sessions, enforces scopes per-message
│   ├── session.ts              # Wraps Claude Agent SDK, routes approvals to clients
│   ├── store.ts                # SQLite: sessions + audit_log tables
│   ├── auth.ts                 # ZeroID JWT verification via @highflame/sdk
│   └── index.ts
├── protocol/
│   ├── types.ts                # Client↔Daemon message protocol (AuthOk, SessionSend, AgentOutput, etc.)
│   ├── scopes.ts               # 8 permission scopes (session:create/list/attach/watch/send/interrupt/approve/destroy)
│   └── index.ts
├── frontends/
│   ├── types.ts                # Frontend plugin interface
│   ├── index.ts
│   ├── telegram/index.ts       # Grammy bot, embedded in daemon process
│   └── web/index.ts            # Mobile-first SPA, served from daemon HTTP
└── terminal/
    └── client.ts               # Terminal client, connects over WebSocket
```

## Core Concepts

### Sessions
A session = one Claude Agent SDK process working in one directory.
Sessions are named, persistent, and independent. Multiple clients can
attach/detach simultaneously from any frontend.

### Auth Model (ZeroID)
Every connection requires a ZeroID JWT. Scopes are enforced per-message:
- `session:create` / `session:destroy` — lifecycle
- `session:attach` / `session:watch` — connect to sessions
- `session:send` / `session:interrupt` / `session:approve` — interact

Delegation: users can share scoped tokens (e.g. read-only watcher) with teammates.
Revocation: kill a token → immediately lose access.
Audit: every action attributed to a ZeroID subject in SQLite.

### Device Handoff
Sessions live in the daemon. Clients are stateless. Detach from terminal →
attach from Telegram → same session, same context, no state loss.

## Tech Stack
- TypeScript, Node 20+
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- ZeroID auth (`@highflame/sdk` — local file link to ../highflame-sdk/javascript)
- WebSocket (`ws`), SQLite (`better-sqlite3`), Telegram (`grammy`), CLI (`commander`)
- Web UI: vanilla JS SPA with CSS custom properties, Telegram Mini App compatible

## Code Patterns

### Async/Error Handling
- All I/O is async
- Agent errors caught and broadcast to attached clients, never crash daemon
- Permission requests surfaced to all attached clients, first response wins

### Security
- ZeroID JWT verified on every connection (local JWKS, no round-trip)
- Scopes enforced per-message in SessionManager
- Telegram: user ID allowlist as first gate, ZeroID as second
- API keys deleted from Telegram chat on /auth
- Audit log: every action attributed to a ZeroID subject

## Commands

```bash
npm run build        # tsup
npm run typecheck    # tsc --noEmit
npm run lint         # biome

codeoid start        # daemon + all frontends
codeoid ls           # list sessions
codeoid new <n> <d>  # create session
codeoid attach <n>   # interactive attach
codeoid send <n> <m> # one-shot message
codeoid interrupt <n>
codeoid approve <n>
codeoid destroy <n>
```

## Config

```bash
CODEOID_API_KEY=zid_sk_...           # ZeroID API key
ZEROID_URL=http://localhost:8899     # ZeroID server
ANTHROPIC_API_KEY=sk-ant-...         # Claude API
TELEGRAM_BOT_TOKEN=...              # Optional: enables Telegram frontend
TELEGRAM_ALLOWED_USER_IDS=123,456   # Required with bot token
```

Web UI available at `http://localhost:7400/app` when daemon is running.
