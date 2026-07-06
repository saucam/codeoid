# Changelog

All notable changes to **codeoid** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-06

### Added

- **`@codeoid/protocol`** — the client↔daemon wire protocol (message/event
  types, `PROTOCOL_VERSION`, permission scopes, published input `LIMITS`) is
  now a standalone npm package, the single source of truth consumed by the
  daemon, the web UI, and the upcoming mobile client. Runtime validation
  schemas ship as an optional subpath (`@codeoid/protocol/schemas`, zod as an
  optional peer). (#101, #102, #105)
- **`@codeoid/core`** — framework-agnostic client core: the WebSocket
  transport (auth handshake, request correlation, heartbeat, jittered-backoff
  reconnect, injectable timing), transcript-accumulation semantics
  (`MessageStore` + kernels with full broadcast routing via `ingest()`),
  `replay.resume` cursor tracking, and shared display helpers. The web UI now
  consumes it; the mobile client is next. (#115)
- **Typed auth handshake + capability negotiation** — clients declare
  `protocolVersion` and `capabilities` on the auth frame; the daemon answers
  with its own on `auth.ok`. (#102)
- **Incremental resume (`replay.resume`)** — reconnecting clients replay only
  the tail mutated since their cursor instead of the full scrollback; falls
  back to a snapshot on daemon restart. (#103)
- **Send idempotency (`send.idempotency`)** — `session.send.clientMsgId`
  dedupes ambiguous-delivery retries so one prompt can't become two billed
  turns. (#103)

### Fixed

- **Daemon**: the 300s turn-stall watchdog force-recovered sessions running
  long tools (multi-minute Bash, Task subagents, web research emit no events
  until completion) and killed runs when a message or a >5-minute-pending
  approval arrived mid-tool. Silence now only counts as a stall while the
  model should be generating; tool execution and pending approvals pause the
  watchdog (finer-grained hung-tool protection is unchanged). (#104)
- **Daemon**: a scrollback replay larger than the WS backpressure limit
  force-closed every client that attached — a permanent reconnect loop on
  large sessions. Replays are now chunked and paced on socket drain, which
  also makes first paint incremental on big sessions. (#84, #100)
- **Daemon**: inbound frames are now schema-validated (unknown fields
  stripped per the additive-protocol contract, unknown verbs and
  out-of-bounds payloads rejected) — including a size cap on `session.send`
  text as a token-bill safety net. (#102)
- **Client core**: the initial auth handshake now has a deadline (a peer that
  accepted the socket but never answered previously hung `connect()`
  forever); concurrent `connect()` calls join the in-flight attempt instead
  of throwing; duplicate request ids are rejected instead of silently
  clobbering the earlier request; one throwing subscriber can no longer break
  message/status dispatch for other subscribers. (#115)
- **Web**: retired the hand-maintained protocol mirror (and with it, dead
  handling for a `"working"` status no released daemon ever emitted). (#105)

## [0.1.3] - 2026-07-03

### Fixed

- **Daemon**: streamed assistant/thinking messages were pushed into scrollback
  twice (stream start + finalize) — duplicating rows on every replay/attach,
  splitting memory episodes into promptless halves, and drifting the byte
  accounting negative so the 20MB scrollback cap never fired. Scrollback now
  upserts by messageId with real UTF-8 byte accounting, and the transcript
  `seq` counter resumes past the persisted tail instead of restarting at 0. (#74)
- **Web**: transcript virtualizer was never notified on count/session changes
  (stale layout ghosting after session switches and size-cache poisoning — the
  residual cause of the row-overlap bug #73 targeted); scrolled-past rows
  leaked their DOM subtrees forever; `session.list` was ingested twice per
  refresh and rebuilt every sidebar row; pending-approval and notification
  watchers re-scanned the full transcript on every streaming delta; usage
  analytics showed *global* totals to identities owning zero sessions and
  broke past ~1000 sessions (SQLite variable limit); analytics chart mixed
  local-time and UTC day buckets. (#75)
- **Telegram**: every streamed assistant/thinking block was delivered twice;
  one unhandled handler error (e.g. `/ls` rendering an unescaped
  `tool_running` status) permanently stopped long polling; flood-limited
  (429) messages vanished silently — grammY auto-retry now honors
  `retry_after`; interleaved broadcasts mid-stream dropped or duplicated
  streamed text; >4000-char replies could arrive with chunks out of order;
  tool completion/cancellation states never rendered; buffered content was
  silently discarded on session switch/detach and stale broadcasts from a
  detached session could write into the new session's chat. (#76)

## [0.1.2] - 2026-06-28

### Fixed

- File explorer now switches working directory when the active session changes,
  instead of staying pinned to the previous session's workdir.
- Interrupted tool calls are marked **cancelled** rather than **failed**, and
  in-flight tool calls are reconciled correctly on session resume.
- Guard `writeBatch` against in-flight streams to stop the TUI double-printing
  streamed output.
- TUI reconnects and re-mints its token on JWT expiry instead of stalling.
- Telegram `/attach` now disconnects the old session before switching, fixing a
  session leak on switch.

### Changed

- Richer README badges (npm version + downloads, coverage, provenance).

## [0.1.1] - 2026-06-24

### Added

- Install-from-npm instructions in the README.

### Changed

- CI publishes to npm via OIDC Trusted Publishing (tokenless), with provenance.

## [0.1.0] - 2026-06-23

Initial public release.

### Added

- Identity-first daemon (Bun) that owns every session; stateless clients attach
  over a versioned WebSocket protocol (`PROTOCOL_VERSION`).
- Cross-session **verbatim memory** — SQLite + FTS5 + vectors, exposed to Claude
  as an in-process MCP server (`recall`, `recall_file`, `timeline`), workspace-scoped
  on `git-common-dir` so worktrees share one memory.
- Frontends: built-in Ink TUI, SolidJS web UI (served at `/ui`), Telegram bot.
  The recommended native Rust TUI lives in
  [codeoid-ui](https://github.com/saucam/codeoid-ui).
- Execution modes (`guarded` / `interactive` / `autonomous` with a write-action
  budget), mid-turn streaming input, backing-session auto-rotation, declarative
  CLI-output compression, and device handoff with scrollback replay.
- ZeroID identity per session plus attenuated sub-agent tokens; every tool call
  is stamped with the acting agent's SPIFFE identity.

[Unreleased]: https://github.com/saucam/codeoid/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/saucam/codeoid/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/saucam/codeoid/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/saucam/codeoid/releases/tag/v0.1.0
