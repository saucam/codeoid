# Contributing to Codeoid

Thanks for your interest in improving Codeoid. This guide covers local setup,
the development loop, and what we expect on a pull request.

## Project layout

Codeoid is a [Bun](https://bun.sh) daemon that wraps the Claude Agent SDK and
serves multiple frontends (web, Telegram) from one process. The terminal client
lives in a **separate repo**, [`codeoid-ui`](https://github.com/saucam/codeoid-ui)
(Rust/Ratatui) — see [README § Terminal client](README.md#terminal-client).

```
src/
├── cli.ts            # CLI entry: start, login, ls, new, attach, send, …
├── config.ts         # ~/.codeoid/config.json + ~/.codeoid/.env + env vars
├── daemon/           # Bun.serve() server, SessionManager, Session, store, auth, memory
├── protocol/         # client↔daemon message types + permission scopes
└── frontends/        # web-ui (SolidJS at /ui), telegram (Grammy)
web/                  # the SolidJS web app (built to web/dist, served at /ui)
```

A fuller map lives in [`CLAUDE.md`](CLAUDE.md).

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A ZeroID key for running end to end (`codeoid login` — see the README)
- Claude auth via `claude login` or `ANTHROPIC_API_KEY`

## Development loop

```bash
bun install            # install deps (also installs web/ deps)

bun run dev            # daemon with --watch (hot reload)
bun run typecheck      # tsc --noEmit — must pass
bun run lint           # biome check
bun test               # daemon + unit tests (src/tests, src/daemon)

# Web app (SolidJS) — from web/
cd web
bun run dev            # vite dev server (standalone)
bun run typecheck      # tsc -b --noEmit
bun run build          # IMPORTANT: builds with --base=/ui/ (served under /ui)
bun run test           # vitest
```

> The web app is served by the daemon under `/ui/`, so it **must** be built with
> Vite `base=/ui/`. `bun run build` already does this — don't call `vite build`
> directly without the base or assets will 404.

## Style

- TypeScript, 2-space indentation. Match the surrounding code — comment density,
  naming, and idioms should read like the file you're editing.
- Keep changes focused; prefer small, reviewable PRs.
- Don't introduce new runtime dependencies casually — Codeoid ships as a small
  single-bundle binary and values a lean dependency tree.

## Before you open a PR

1. `bun run typecheck` is clean.
2. `bun test` (and `cd web && bun run test` if you touched the web app) passes.
3. New behavior has a test where practical — the daemon has good coverage of
   session lifecycle, attachments, memory, and protocol handling; add to it.
4. If you changed the client↔daemon protocol (`src/protocol/`), keep the Rust
   protocol crate in [`codeoid-ui`](https://github.com/saucam/codeoid-ui)
   (`crates/codeoid-protocol`) in lockstep — the wire format is shared.

## Reporting bugs & security

- Functional bugs: open an issue with repro steps, expected vs actual, and
  daemon logs (`/tmp/codeoid.log` by default) when relevant.
- Security issues: **do not** open a public issue — see [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree your contributions are licensed under the project's
[MIT License](LICENSE).
