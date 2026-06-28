# Changelog

All notable changes to **codeoid** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
