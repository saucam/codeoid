# Codeoid

**Identity-first remote control plane for AI coding agents.**

Control your AI coding agents from your phone, laptop, or any device — with every connection cryptographically verified by [ZeroID](https://github.com/highflame-ai/zeroid).

```
Phone (Telegram)  ──┐
                    ├──▶  Codeoid Daemon  ──▶  Claude Agent SDK
Laptop (Terminal)  ──┘         │
                          ZeroID (auth)
```

## Why Codeoid?

Every existing tool for remote-controlling AI agents uses Telegram user IDs or static passwords. Codeoid uses **real identity infrastructure**:

- **Cryptographic auth** — ZeroID JWTs verified locally via JWKS
- **Scoped permissions** — read-only watchers vs. full session control
- **Delegation** — share access with teammates, revoke instantly
- **Audit trail** — every action attributed to a verified identity
- **Multi-session** — N parallel agent sessions, attach/detach independently
- **Device handoff** — pause on laptop, continue from phone, same session

## Quick Start

### 1. Install

```bash
npm install -g codeoid
```

### 2. Start ZeroID (for auth)

```bash
# In the zeroid repo
make setup-keys && docker compose up -d
```

### 3. Register and get an API key

```bash
curl -X POST http://localhost:8899/api/v1/agents/register \
  -H "Content-Type: application/json" \
  -H "X-Account-ID: personal" \
  -H "X-Project-ID: dev" \
  -d '{"name": "my-codeoid", "external_id": "codeoid-1", "sub_type": "orchestrator", "trust_level": "first_party", "scopes": "session:create session:list session:attach session:watch session:send session:interrupt session:approve session:destroy"}'
```

Save the `api_key` from the response.

### 4. Configure

```bash
export CODEOID_API_KEY=zid_sk_...
export ZEROID_URL=http://localhost:8899
export ANTHROPIC_API_KEY=sk-ant-...
```

### 5. Start the daemon

```bash
codeoid start
```

### 6. Use from terminal

```bash
# Create a session
codeoid new oracle /path/to/highflame-oracle

# List sessions
codeoid ls

# Attach and start working
codeoid attach oracle
> Review the webhook handler for security issues
> /interrupt
> /detach
```

### 7. Use from Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Set environment variables:
   ```bash
   export TELEGRAM_BOT_TOKEN=...
   export TELEGRAM_ALLOWED_USER_IDS=your_telegram_id
   ```
3. Start the bot:
   ```bash
   codeoid telegram
   ```
4. In Telegram:
   ```
   /auth zid_sk_...
   /new oracle /path/to/repo
   /attach oracle
   Review the webhook handler
   ```

## Architecture

```
┌─────────────┐         ┌──────────────────┐
│  Telegram    │─token──▶│                  │
│  (phone)     │◀────────│  Codeoid Daemon  │       ┌─────────┐
└─────────────┘         │                  │──────▶│ ZeroID  │
                        │  Sessions:       │◀──────│ (JWKS)  │
┌─────────────┐         │  ┌────────────┐  │       └─────────┘
│  Terminal    │─token──▶│  │ oracle     │──┤──▶ Claude Agent SDK
│  (laptop)    │◀────────│  │ shield     │──┤──▶ Claude Agent SDK
└─────────────┘         │  │ core       │──┤──▶ Claude Agent SDK
                        │  └────────────┘  │
                        │                  │
                        │  SQLite (audit)  │
                        └──────────────────┘
```

### Permission Scopes

| Scope | Description |
|-------|-------------|
| `session:create` | Create new sessions |
| `session:list` | List sessions |
| `session:attach` | Attach with full interaction |
| `session:watch` | Read-only session output |
| `session:send` | Send messages to agent |
| `session:interrupt` | Interrupt running agent |
| `session:approve` | Approve/deny permission requests |
| `session:destroy` | Destroy sessions |

### Sharing Access

```bash
# Give a teammate read-only access
curl -X POST http://localhost:8899/oauth2/token \
  -d '{"grant_type": "token_exchange", "subject_token": "YOUR_TOKEN", "scope": "session:list session:watch"}'
# → Short-lived JWT with only list + watch permissions
# → Share with teammate, revoke anytime
```

## Development

```bash
git clone https://github.com/highflame-ai/codeoid
cd codeoid
npm install
npm run dev        # Watch mode
npm run build      # Production build
npm run typecheck   # Type check
npm run lint       # Biome lint
```

## License

MIT

---

Built by [Highflame](https://highflame.ai). Powered by [ZeroID](https://github.com/highflame-ai/zeroid).
