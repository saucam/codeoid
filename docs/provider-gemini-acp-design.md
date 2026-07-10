# Google-subscription backend — gemini-cli over ACP (design)

> Untracked design doc. Spike verified 2026-07-10. Supersedes the earlier
> "Antigravity SDK" idea — see Findings. Template: pi (#131–135) + codex (#142).

## Findings (verified)

- **There is no official Google "Antigravity SDK"** on npm. The `antigravity-sdk`
  package (1.7.0) is a *community* kit for building Antigravity IDE
  *extensions* — wrong direction (extends the IDE, doesn't expose the agent),
  community-owned (supply-chain risk), no subscription-auth story for us.
- **`@google/gemini-cli@0.50.0` (official) ships a STABLE `--acp` flag** —
  "Starts the agent in ACP mode" (`--experimental-acp` now deprecated). This is
  the Google-subscription harness: gemini-cli's auth is the user's Google
  account OAuth in `~/.gemini` (free tier / AI Pro / Code Assist), exactly the
  codex/claude posture — codeoid never touches tokens.
- **ACP = Agent Client Protocol** (`@zed-industries/agent-client-protocol`,
  0.4.5) — a STANDARDIZED editor↔agent protocol: JSON-RPC over stdio, same
  transport shape as codex app-server. Native seams:
  - `session/new` / `session/load` → backing session
  - `session/prompt` → turn; `session/update` notifications → text/thought/
    tool-call streaming; `session/cancel` → interrupt
  - `session/request_permission` (server→client request) → `canUseTool` —
    native approvals again, no bridge
  - `fs/read_text_file` + `fs/write_text_file` (agent asks the CLIENT to do
    file I/O) — decide policy: implement + gate writes through canUseTool, or
    decline capability so the agent uses its own tools
  - gemini-cli `--approval-mode default` prompts for approval — pin it
    (fail-closed parity with pi/codex).

## Why this beats a bespoke integration

An `AcpProvider` is **agent-agnostic**: gemini-cli first, but any ACP-speaking
agent (the growing Zed ecosystem) becomes a codeoid backend for free —
registry entries per agent binary over one protocol client. Strongest possible
expression of the meta-harness bet.

## Shape (mirror codex/)

`src/daemon/providers/acp/{rpc,translate,resolve,index}.ts`:
- reuse the newline JSON-RPC client pattern from codex/rpc.ts (consider
  extracting a shared `jsonrpc-stdio.ts` — codex + acp are near-identical)
- `GeminiAcpProvider` (or generic `AcpProvider` parameterized by binary +
  id/displayName) — warm process, `initialize` (ACP version + client caps),
  `session/new {cwd, mcpServers: []}`, prompt turns, permission requests →
  canUseTool, `session/update` → ProviderEvent
- resolution: config `providers.gemini_cli.command` → PATH → bundled
  `@google/gemini-cli` optionalDependency (pure JS like pi — bundling audit
  should pass; pin exact)
- env: `buildGeminiCliEnv` — `GEMINI_`, `GOOGLE_` prefixes + shared basics
  (`~/.gemini` via HOME)
- naming: provider id `gemini-cli` (distinct from stateless `gemini`);
  displayName "Gemini CLI (Google)"
- fake-acp fixture + C-series tests, per the codex template

## Open questions
1. ACP schema details: pull `@zed-industries/agent-client-protocol` types
   (typed, versioned) instead of hand-rolling frames.
2. fs/* capability: v1 recommendation — advertise `fs: false` so gemini-cli
   uses its own tools (all gated by approval-mode), revisit later.
3. Does Antigravity itself ever expose an official agent protocol/SDK? Re-check
   before GA; if yes, it likely also speaks ACP (it's Zed-adjacent tooling) —
   the AcpProvider would absorb it.
