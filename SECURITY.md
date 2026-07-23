# Security Policy

Codeoid is an identity-first control plane: it brokers ZeroID-authenticated
access to AI coding agents that read and write your filesystem and run shell
commands. We take its security posture seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
<https://github.com/highflame-ai/codeoid/security/advisories/new>

Include repro steps, affected version/commit, and impact. We'll acknowledge,
investigate, and coordinate a fix and disclosure timeline with you.

## Security model (what to keep in mind)

- **Auth is mandatory.** Every connection requires a valid ZeroID JWT; scopes
  are enforced per-message (`session:create`, `session:send`, `session:approve`,
  …). `account_id` / `project_id` are derived from token claims, never from
  client-supplied headers.
- **The daemon binds to `127.0.0.1` by default.** Exposing it on a public
  interface (`--host 0.0.0.0`) puts agent execution behind only the ZeroID
  token — do this only behind your own authenticated tunnel/proxy.
- **Agents execute code.** A session runs the Claude Agent SDK with `Read`,
  `Write`, `Edit`, `Bash`, and `Agent` tools in the session's working directory.
  Use the permission modes (`interactive` / `auto-allow` / `autonomous`) and the
  approval flow to bound what runs unattended.
- **Secrets at rest.** `~/.codeoid/config.json` (ZeroID key) and `~/.codeoid/.env`
  (Telegram token, etc.) are written mode `600`. They are excluded from git.
  Never commit them. The Telegram frontend deletes messages containing an API
  key after exchange.
- **Sub-agent identities are attenuated.** When agent identities are enabled,
  sub-agents receive a scoped subset of the parent's ZeroID scopes; revoking the
  parent cascades.

## Scope

In scope: the daemon, its frontends, auth/scope enforcement, secret handling,
and the client↔daemon protocol. Out of scope: vulnerabilities in upstream
dependencies (report those upstream), and ZeroID itself (report to its project).

## Supported versions

Codeoid is pre-1.0; security fixes land on `main`. Run a recent build.
