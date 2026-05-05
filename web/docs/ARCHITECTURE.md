# Codeoid web — architecture

> A web frontend for the Codeoid daemon. Production-grade, lightweight,
> Solid-based. This document is the orientation a new contributor (or
> future Claude session) needs to pick up cold.

## Mental model

The codeoid daemon is the source of truth. The web UI is a **pure renderer** —
it consumes daemon broadcasts and translates UI events back into protocol
messages. State that matters (sessions, transcripts, usage, identities)
lives daemon-side. The web UI holds:

- A WebSocket connection to the daemon
- A handful of derived signals (sessions list, focused id, message store
  per session, viewport scroll state, prompt drafts)
- Local UI state (which file is open in the right pane, which modal is
  visible, focus mode)

That's it. Anything you find yourself wanting to "track in the browser"
that the daemon already knows, push the question back to the daemon. Why:
it lets any frontend (TUI, web, Telegram) auto-resume any session. A user
opens the web UI on their phone mid-meeting and finds the same session
they left running on their laptop, exactly where they were.

## Stack

| Layer | Pick | Why |
|---|---|---|
| Framework | Solid.js 1.9 | Fine-grained reactivity — token streaming = single text node update, no VDOM diff |
| Build | Vite 6 | Instant HMR, ESM-native; pinned to v6 because the host's Node is on 21 (Vite 7+ wants 22+) |
| Lang | TypeScript 5.7, strict | `noUncheckedIndexedAccess`, `noUnusedLocals`, `noFallthroughCasesInSwitch` all on |
| Style | Tailwind 4 + design tokens | `@theme` block in `src/index.css` is the design system; every color/font/motion easing flows from there |
| Markdown | solid-markdown + remark-gfm | Assistant message render |
| Highlighting | shiki | VS Code's actual highlighter; lazy-loaded themes |
| Virtualization | @tanstack/solid-virtual | Transcript pane stays smooth at 10k+ messages |
| Positioning | @floating-ui/dom | Tooltips, popovers; same engine VS Code uses |
| Motion | motion (vanilla) | ~2KB; most transitions stay in CSS |
| State | Solid signals + `createStore` | No external state lib; signals are the primitive |
| Tests | vitest (node by default; jsdom opt-in per-file) | |

No UI library. We roll our own modals, tabs, dropdowns. Cost: ~500-1k LoC over
time. Win: zero "fight the framework" moments + a bundle small enough to
actually be a competitive advantage.

## Directory layout

```
web/
├── docs/
│   ├── ARCHITECTURE.md       ← this file
│   └── DECISIONS.md          ← short record of judgment calls (ADR-lite)
├── index.html
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
├── package.json
└── src/
    ├── main.tsx              ← entry; renders <App />
    ├── App.tsx               ← top-level shell (3-pane layout)
    ├── index.css             ← Tailwind 4 imports + @theme tokens
    ├── protocol/
    │   └── types.ts          ← TS mirror of codeoid/src/protocol/types.ts
    ├── lib/
    │   ├── auth.ts           ← API-key → JWT exchange against ZeroID
    │   ├── format.ts         ← formatTokens, formatCostUsd, formatDuration, …
    │   └── ws.ts             ← CodeoidClient — WS lifecycle + req/resp correlation
    ├── state/                ← (forthcoming) signal-backed stores
    └── components/           ← (forthcoming) UI by feature
```

## Lifecycle: cold start to first message render

1. Browser loads `/` → React-shaped JSX from `App.tsx` mounts.
2. App reads a remembered API key from `localStorage` (key
   `codeoid.apiKey`). If missing, render the sign-in surface.
3. `lib/auth.resolveToken` POSTs `grant_type=api_key` to
   `${ZEROID_URL}/oauth2/token` and receives a JWT. JWT lives only in
   memory.
4. `new CodeoidClient({ url, token }).connect()` opens the WS, sends
   `{ type: "auth", token }` as the first frame, and resolves on the
   daemon's `auth.ok`.
5. App sends `{ type: "session.list", id }` and listens for the
   `session.list.result` matching that id.
6. Each session row renders with usage metrics from `SessionInfo.usage`.
7. User clicks a session → app sends `session.attach`. Daemon replies
   with `scrollback.replay` (full message history). Subsequent messages
   stream as `session.message` (full) or `session.message.delta`
   (token-by-token).

## Auth contract recap

| Header / step | Purpose |
|---|---|
| `POST /oauth2/token` with `grant_type=api_key` + `scope=…` | ZeroID mints a JWT carrying the requested scopes in `scopes` claim |
| First WS frame `{ type: "auth", token }` | Daemon `verifyToken` validates against ZeroID JWKS, populates AuthContext.scopes |
| `auth.ok` | Carries identity + actual granted scopes + protocol version |

The web UI requests `DEFAULT_WEB_SCOPES` on every exchange. Without the
explicit `scope` parameter, ZeroID would issue a JWT with no scopes and
the daemon's per-message gates would reject everything.

The JWT is short-lived; on `403 invalid_jwt` we re-exchange the API key.

## Protocol verbs the web UI sends

(Tier 1 / parity targets — implemented progressively.)

- `session.list` — populate sidebar
- `session.create { name, workdir }` — new session modal
- `session.attach`, `session.detach`
- `session.send { sessionId, text, attachments?, priority? }`
- `session.interrupt`, `session.rotate`, `session.destroy`, `session.rename`
- `session.set_mode { mode, maxTurns? }`
- `session.set_model { model, fallbackModel? }`
- `session.search { query, scope?, workdir?, limit? }`
- `session.approve { approvalId, approved }`
- `fs.list { sessionId, path }` — scoped to the session's workdir
- `fs.read { sessionId, path, maxBytes? }` — UTF-8 text or base64 binary

## Daemon broadcasts the web UI consumes

- `auth.ok`
- `session.list.result`, `session.search.result`
- `session.message`, `session.message.delta`
- `scrollback.replay`
- `session.status_change`, `session.info_update`
- `response.ok`, `response.error`
- `fs.list.result`, `fs.read.result`

## Metrics surface

`SessionInfo.usage` already carries everything: cumulative `inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `totalCostUsd`,
`numTurns`, `durationMs`, plus `recentTurns[]` and last-turn breakdowns.
`createdAt` on `SessionInfo` gives wall-clock session start. Everything
client-side is render-only via the helpers in `src/lib/format.ts`.

## Pinned constraints

1. **No client-side pricing tables.** Cost ships from the daemon (SDK-reported).
2. **No client-side persistence of session content.** localStorage holds
   the API key + per-session prompt drafts only.
3. **No optimistic UI for lifecycle ops.** Send the verb, wait for the
   broadcast, render the new state. Avoids drift.
4. **Strict TS + run `bun run typecheck` before each commit.**
5. **Tests for non-trivial logic.** Pure helpers (format, reducers,
   message store) get vitest coverage. UI components get spot-checked
   with `@solidjs/testing-library` + jsdom only where worth it.

## Roadmap

Phase markers used in commits:

- **P1 — scaffold + protocol + WS** (this commit)
- **P2 — state stores + minimal layout wired to live data**
- **P3 — sessions feature (list, create, rename, destroy)**
- **P4 — transcript + prompt + approvals**
- **P5 — file explorer + read-only viewer ✓ daemon `fs.list`/`fs.read` shipped**
- **P6 — controls (interrupt, rotate, mode, model, search)**
- **P7 — polish (motion, virtualization, shiki, accessibility)**

Each phase ends green: typecheck + build + tests, plus a manual smoke
test in dev. Branch `feat/web-ui-solid` until the parity ships.
