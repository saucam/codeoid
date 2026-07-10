# Codex as a codeoid backend — implementation design

> Untracked design doc (convention: like `provider-followups-handoff.md`).
> Grounded 2026-07-10 against the REAL protocol schema of `@openai/codex@0.144.1`
> (`codex app-server generate-json-schema` / `generate-ts` — regenerate, don't trust
> this doc over the generator). Follow the pi provider template throughout
> (#131–135 + `feat/pi-bundled`).

## Why

Codex brings agentic GPT with **ChatGPT-subscription auth** (codex owns its login
store in `~/.codex`, incl. `ChatgptAuthTokensRefresh` — codeoid never touches
tokens). Fills the same slot pi does for its providers: a native harness driven at
full fidelity, NOT a raw-API reimplementation. The stateless `openai` provider
stays as the API-key chat tier.

## Integration surface (verified against 0.144.1)

- **Transport:** `codex app-server` — JSON-RPC over stdio, experimental but
  self-describing: `generate-ts` emits TypeScript bindings, `generate-json-schema`
  emits the schema (v2 = 516 defs). Vendor the generated types under
  `src/daemon/providers/codex/protocol/` (build step or checked-in, pinned to the
  bundled codex version).
- **Backing session = thread:** `ThreadStart` / `ThreadResume` / `ThreadFork` /
  `ThreadArchive`. Thread id is the `backingSessionId` (mirrors pi's session file).
  `resetToNewSession` = start a fresh thread.
- **Event stream → ProviderEvent (near 1:1):**
  | codex v2 notification | ProviderEvent |
  |---|---|
  | `AgentMessageDelta` | `text_delta` (+ accumulate for `text_done`) |
  | `ReasoningTextDelta` / `ReasoningSummaryTextDelta` | `thinking_delta` |
  | `ItemStarted` / `ItemCompleted` (command, file change, tool call items) | `tool_start` / `tool_complete` |
  | `TurnStarted` / `TurnCompleted` | turn boundary → `turn_done` (`NormalizedTurnResult`) |
  | `ThreadTokenUsageUpdated` | `llm_call` usage |
  | `Error` | `error` |
  | `TurnPlanUpdated` / `PlanDelta` | `custom_message` (parts) — optional v2 |
- **Approvals are NATIVE server→client requests** — the big win vs pi (no injected
  bridge extension): `CommandExecutionRequestApproval`,
  `FileChangeRequestApproval`, `ApplyPatchApproval`, `ExecCommandApproval`,
  `PermissionsRequestApproval`. Handler: translate each into codeoid's
  `canUseTool(toolId, approvalId, toolName, input)` and answer the JSON-RPC
  request with approve/deny. Set codex's own policy to always-ask
  (`-c` overrides / `TurnEnvironmentParams`) so EVERY privileged action routes
  through codeoid — fail-closed parity with the pi bridge: if approval policy
  can't be pinned to ask, fail the turn, don't run ungated.
- **`ToolRequestUserInput`** (questions with options) → `requestUserInput`
  (`UiRequestFn` → `session.ui_request` from #131). Perfect fit.
- **Dynamic commands:** custom prompts live in `~/.codex/prompts`; if the server
  exposes a list (check `ClientRequest` defs), map to `listCommands()`.

## Provider shape

`src/daemon/providers/codex/{index,translate,resolve}.ts`:

- `CodexProvider implements SessionProvider` — warm (keep the app-server child
  alive across turns), `pushMidTurn` likely unsupported at first (interrupt +
  re-send; check `TurnAbort`/interrupt params in schema).
- `seedFromHistory` = `renderHistorySeed` string prepend (same ceiling as
  claude/pi; `ThreadResume` only resumes codex's OWN threads).
- **Spawn env**: `buildSubprocessEnv` policy — `exact: []`, prefixes
  `["OPENAI_", "CODEX_"]` is NOT enough on its own: codex reads `~/.codex`
  via HOME (already in shared basics). DENY list already protects `CODEOID_*`.
  Mirror `buildPiEnv` with a `buildCodexEnv`.
- **Resolution/bundling**: reuse `feat/pi-bundled` infra —
  `resolveCodexCommand` (config `providers.codex.command` → PATH → bundled
  `@openai/codex` optionalDependency). NOTE: `@openai/codex` ships a Rust binary
  per-platform (native pkg) — bundled fallback spawns the platform binary from
  the package, NOT `process.execPath + js`. Verify install size/platform matrix
  before pinning; if too heavy, ship resolution + `markUnavailable` hint only
  (the registry infra from #141 handles the UX either way).
- **Config**: `providers.codex: { enabled: true, command: "codex" }` — same
  schema shape as pi.
- **Registry**: factory gated on resolution, `markUnavailable` hint otherwise.

## Tests (pi template)

- `fake-codex` fixture: a bun script speaking newline JSON-RPC — initialize,
  thread start, scripted turn with AgentMessageDelta/Item*/Turn* notifications,
  and an approval server-request the test answers through the provider.
- Provider unit tests mirroring `provider-pi.test.ts` T1–T11: turn translation,
  approval allow/deny round-trip, fail-closed when approval policy can't be
  pinned, usage deltas, seedFromHistory prepend, missing binary.
- Wire is already provider-agnostic — no protocol changes expected at all.

## Open questions (decide while building)

1. v2 vs v1 protocol surface — generate both, target v2 (`thread/turn` model);
   confirm which one `app-server` speaks by default and whether `initialize`
   negotiates.
2. Interrupt semantics — find the turn-abort request; map `TurnRun.interrupt()`.
3. Sandbox interplay — codex has its own sandbox (`codex sandbox`,
   `sandbox_permissions` config). Decide default: disable codex sandboxing and
   rely on codeoid approvals (pi parity), or keep both layers. Start with both
   (defense in depth), document.
4. Model catalog — `listModels()` from config/`Account*` requests, else static.

## Suggested first PR slice

Resolution + registry entry + spawn + initialize/thread-start + text-only turn
translation with approvals mapped (fail-closed) + fake-codex tests. Items/plan
richness and commands can follow wire-additively.

## Probe results (2026-07-10, live against @openai/codex@0.144.1 app-server)

- **Framing:** newline-delimited JSON-RPC 2.0 over stdio. No Content-Length.
- **Handshake:** `initialize {clientInfo:{name,title,version}}` → result `{userAgent, codexHome,...}`; then notification `initialized`.
- **Thread:** `thread/start {cwd, approvalPolicy?, sandbox?, developerInstructions?, baseInstructions?, model?, ephemeral?}` → `{thread:{id, ...}}` + `thread/started` notif. `thread/resume {threadId,...}` to reattach. Thread id = backingSessionId.
- **Turn:** `turn/start {threadId, input:[{type:"text", text, text_elements:[]}], cwd?, approvalPolicy?, sandboxPolicy?, model?, effort?}`. Mid-turn: `turn/steer`. Interrupt: `turn/interrupt`.
- **systemPromptAppend** → `developerInstructions` on thread/start (verify precedence vs baseInstructions).
- **Streaming notifications:** `item/agentMessage/delta` (text), `item/reasoning/textDelta` + `item/reasoning/summaryTextDelta` (thinking), `item/started`/`item/completed` (items: commandExecution, fileChange, mcpToolCall, webSearch, agentMessage, reasoning, plan), `item/commandExecution/outputDelta`, `turn/started`/`turn/completed` (usage), `thread/tokenUsage/updated`, `error`.
- **Server→client approval requests (answer the JSON-RPC id):** `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` / `item/permissions/requestApproval` `{threadId, turnId, itemId, approvalId?, ...}`; `item/tool/requestUserInput` (questions+options → session.ui_request).
- **Models:** `model/list {}` → `{data:[{id, model, displayName, description, supportedReasoningEfforts[...]}]}` — direct `listModels()`.
- **Auth:** `getAuthStatus`, `account/login/start` (ChatGPT subscription login lives in codex; `~/.codex` via HOME).
- Generated TS bindings: `codex app-server generate-ts` (vendor under providers/codex/protocol, pinned).
