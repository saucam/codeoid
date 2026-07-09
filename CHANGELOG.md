# Changelog

All notable changes to **codeoid** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Mid-session provider switching** (`session.set_provider`, `/provider
  <id>`): swap a live session's backend (claude ⇄ pi ⇄ gemini ⇄ openai)
  while keeping the session id, scrollback, transcript, and identity. The
  generic switch loop tears down the outgoing backend, re-mints the backing
  id (an incoming backend never resumes the outgoing one's native state),
  resets the model to the new backend's default, and offers the accumulated
  canonical history to the incoming provider via the new optional
  `seedFromHistory()` — stateless backends no-op it (they consume
  `TurnOpts.history` natively), warm backends (claude, pi) prepend a
  rendered transcript (`renderHistorySeed`, newest-turns-first truncation)
  to their first post-switch prompt. Fidelity contract: the new backend
  gets a faithful TRANSCRIPT, not a native continuation. Fail-closed on
  unknown ids, rejected mid-turn (interrupt first), serialized against
  racing prompts, seed failures degrade to an unseeded switch, and every
  switch is audited + announced in the transcript with structured metadata.

- **pi is now an officially supported session backend** (`providerId: "pi"`,
  [docs/providers-pi.md](docs/providers-pi.md)). One codeoid session = one
  warm `pi --mode rpc` subprocess; pi's own session file is the backing id,
  so daemon restarts resume the same pi conversation. What flows through:
  - **pi extensions work end-to-end** — hooks run inside pi; extension
    dialogs surface as codeoid `session.ui_request` dialogs, notifications
    become transcript rows, and extension/prompt/skill slash commands feed
    `session.commands` (invoke as `/name args` from any client).
  - **codeoid's approval gate covers pi tools**: an injected bridge
    extension routes every pi `tool_call` through `canUseTool` (modes,
    budgets, `session.approve`, audit). pi has no native permission system,
    so a missing bridge fails turns CLOSED, and any tool that executes
    ungated is flagged loudly.
  - Steering (`now`/`next` → pi steer, `later` → follow-up), model
    switching (`provider/model-id`), per-turn usage deltas, rotation via
    pi `new_session`.
  - Config: `providers.pi.{enabled, command}`.
- **Provider selection is user-facing**: `session.create` accepts
  `providerId` (fail-closed on unknown ids), `auth.ok` advertises the
  daemon's registered `providers` (default first), and the web UI's
  new-session modal grew a backend picker.

- **Provider extension surface** — the wire-additive groundwork for
  non-Claude backends (pi harness next) to expose their full feature set
  through codeoid:
  - **Provider-initiated dialogs** — new `session.ui_request` /
    `session.ui_response` / `session.ui_resolved` messages let a provider (or
    its extensions) ask the user something that is not a tool approval
    (confirm gates, pick-one lists, free text, editors). Daemon-enforced
    timeouts, attach re-delivery, first-answer-wins across clients, interrupt
    cancellation, and stall-watchdog integration. Gated on the new
    `ui.dialogs` capability; the web UI renders them in a new `UiRequestBar`.
  - **Dynamic provider commands** — `session.commands` returns the backing
    provider's slash-command catalog (extension commands, prompt templates,
    skills). Clients pass unknown-but-catalogued verbs through as prompt
    text (`parseSlash` `isProviderCommand` option); the provider expands
    them. Gated on the `commands.dynamic` capability.
  - **Rich parts, actually rendered** — providers can emit standalone
    `custom_message` events with `ContentPart[]`; the web UI now renders
    parts (code, diff, table, tree, progress, image, anchor, button) via a
    new `PartsView`, and `ButtonPart` gets its missing return path: the new
    `session.part_action` verb validates the button against the real message
    and forwards it to the provider's `handlePartAction`.
  - **Provider-declared approval forms** — `tool_start.patchableKeys` lets
    any backend declare which input keys a client may patch on approval,
    generalizing the hardcoded AskUserQuestion whitelist (which remains the
    fallback).
  - **ProviderRegistry wired in** — session backends now come from a
    factory registry built once at daemon startup (previously dead code next
    to a hardcoded `switch`); adding a backend is one `register()` call.
    Unknown provider ids still fall back to the default so resume survives
    metas written by newer codeoids.

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
- **Live model catalog persistence** — the daemon persists the model catalog
  each backend reports (designed provider-agnostic), so restarts and the
  `/model` picker serve current models instead of a hardcoded list that goes
  stale. (#78, #79)

### Security

- **Untrusted-content sinks sanitized**: terminal output and markdown
  link/image URLs from model/tool output are now sanitized before reaching
  dangerous sinks — a `javascript:` link or remote-image exfiltration channel
  in rendered output is dropped. (#91)
- **Cross-tenant memory disclosure fixed**: memory workspace ids were derived
  from the working directory alone, so co-located accounts sharing a path
  could cross-read each other's episodes via `recall`/`timeline`/search.
  Workspace ids are now tenant-scoped. (#93)

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
- **Web**: stale fallback model names in the model picker refreshed to the
  current Claude lineup. (#78)

### Performance

- **Daemon event loop unblocked**: status flips, workspace-id probes, and
  `fs.list` did synchronous/redundant work on the single-threaded event loop,
  stalling token streaming for every session in the process. (#95)
- **Transcripts bounded**: rotation + streaming tail load + output caps — a
  months-old session with a multi-hundred-MB transcript could previously
  block daemon startup past its deadline or OOM it on resume. (#96)
- **Memory recall**: the per-workspace vector cache is appended on embed
  instead of cleared (recall was re-reading and re-decoding every embedding
  BLOB per query during active work), and clustering is single-flight per
  workspace with lean hydration and a yielding k-means. (#94, #97)
- **Web streaming**: markdown is no longer re-parsed from scratch on every
  streaming delta, and the message reducers use O(1) positional lookups
  instead of per-delta scans (O(N²) over a long session). (#98, #99)

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
