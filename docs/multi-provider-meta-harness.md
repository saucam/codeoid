# Multi-Provider Meta-Harness

**Status**: Design — pre-implementation  
**Issue**: [#30](https://github.com/highflame-ai/codeoid/issues/30)  
**Authors**: Yash Datta  

---

## 1. Goal

Make codeoid a production-grade meta-harness: multiple AI providers (Claude, Gemini, Codex) can back sessions, switching at any turn boundary, while sharing the same scrollback, transcript, auth, memory, MCP servers, and tool approval flow.

The differentiator versus Omnigent (Databricks): codeoid intercepts at the API event-stream level, giving it full structured access to every tool call — inputs AND outputs. A switching provider receives the prior conversation in its native API format, including all tool interactions, not just the text narration.

---

## 2. Core Concepts

### 2.1 Canonical History

Codeoid owns the conversation history. It does NOT delegate history to each provider's session persistence (Claude Code's backing session, Gemini session IDs, etc.). This is the only way per-turn provider switching is possible.

Canonical history is stored as an ordered list of `CanonicalTurn` objects:

```typescript
interface CanonicalToolCall {
  id: string;                          // provider tool_use_id (stable key for correlation)
  name: string;                        // normalized snake_case name: "read_file", "run_shell"
  input: Record<string, unknown>;      // tool input (uses Claude Code's field names as reference)
  output: string;                      // tool result, subject to per-type size limits
  success: boolean;
  originalName?: string;               // "Read", "Bash" — for debugging
}

type CanonicalTurn =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;                 // text (may be "" for pure tool-calling turns)
      toolCalls?: CanonicalToolCall[]; // ordered; includes both input and output
      thinking?: string;               // Anthropic extended-thinking only; stripped on conversion
      providerId: string;              // which provider produced this turn
      model: string;                   // full model id
    }
```

**Tool output size limits** — prevent canonical history from overwhelming context windows. Applied at capture time, not at conversion time. When output exceeds the limit, a note is appended: `"…output truncated at 32768 chars (full output was Nk chars)"`.

| Tool category | Limit |
|---|---|
| `read_file` | 32 768 chars (~1 000 lines) |
| `run_shell` | 8 192 chars |
| `str_replace_file`, `write_file` | unlimited (diffs are small) |
| `glob_files`, `list_directory`, `search_in_files` | 8 192 chars |
| `spawn_subagent` | 8 192 chars |
| `mcp__*` tools | 16 384 chars |

These are named constants (`TOOL_OUTPUT_LIMITS` in `providers/canonical.ts`), not hardcoded literals.

**No auto-truncation of turns.** When canonical history would overflow the target provider's context window on a switch, codeoid warns (at 80%) or refuses (at 95%) with a clear message. The user must explicitly rotate or trim. Rationale: silent truncation destroys the guarantee that the next provider has full context.

### 2.2 Tool Name Normalization

Claude Code uses Pascal-case tool names. Canonical uses snake_case. This is a one-way translation applied at capture time, never reversed.

```
Claude Code  →  Canonical
─────────────────────────
Read         →  read_file
Write        →  write_file
Edit         →  str_replace_file
MultiEdit    →  multi_edit_file
Bash         →  run_shell
Glob         →  glob_files
Grep         →  search_in_files
LS           →  list_directory
Task         →  spawn_subagent
WebSearch    →  web_search
WebFetch     →  web_fetch
TodoRead     →  read_todos
TodoWrite    →  write_todos
mcp__*       →  unchanged (already namespaced)
```

Parameter field names follow Claude Code's convention as the reference implementation (e.g. `file_path`, `command`, `old_string`, `new_string`). No second-level field normalization needed.

### 2.3 Format Converters

Canonical history converts to each provider's native API message format on demand — once at switch time, not on every turn. Conversion is an O(n) in-memory JSON transform; at 50 turns + 30 tool calls each it takes < 10ms and is never a bottleneck.

All three provider APIs share the same semantic structure:

```
Anthropic  │ assistant: { content: [tool_use blocks] }
           │ user:      { content: [tool_result blocks] }
───────────┼───────────────────────────────────────────
OpenAI     │ assistant: { tool_calls: [function call objects] }
           │ tool:      { tool_call_id, content }
───────────┼───────────────────────────────────────────
Gemini     │ model:    { parts: [functionCall parts] }
           │ function: { parts: [functionResponse parts] }
```

Conversion is deterministic. Each provider API validates that tool_result messages reference declared tools. To satisfy this, every provider call includes the full canonical tool definition list regardless of which subset appears in history.

---

## 3. AgentProvider Interface

```typescript
// src/daemon/providers/interface.ts

export type ProviderAuth =
  | { type: "subscription" }                     // existing CLI session (claude login, gcloud ADC)
  | { type: "api_key"; apiKey: string }          // direct key
  | { type: "env"; envVar: string };             // read from process.env at runtime

export interface ProviderConfig {
  auth: ProviderAuth;
  defaultModel?: string;
  baseURL?: string;   // override API endpoint (e.g. Azure OpenAI, local proxy)
}

export interface TurnOpts {
  history: CanonicalTurn[];           // all prior turns — provider converts to its own format
  userMessage: string;                // current user turn (not yet in history)
  model?: string;                     // override for this turn
  workdir: string;
  systemPromptAppend?: string;        // memory index injection
  mcpServers?: Record<string, McpServerConfig>;
  canUseTool: ToolApprovalFn;         // codeoid's approval flow, uniform across providers
  signal: AbortSignal;
}

export interface TurnRun {
  events: AsyncIterable<ProviderEvent>;
  interrupt(): Promise<void>;
  pushMidTurn?(text: string, priority: "now" | "next" | "later"): void; // optional; Claude only
}

export interface AgentProvider {
  readonly id: string;                // "claude" | "gemini" | "codex"
  readonly displayName: string;

  initialize(config: ProviderConfig): Promise<void>;
  runTurn(opts: TurnOpts): TurnRun;
  listModels(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}
```

### 3.1 ProviderEvent (normalized stream)

```typescript
export type ProviderEvent =
  | { type: "text_delta"; content: string }
  | { type: "text_done"; content: string }
  | { type: "thinking_delta"; content: string }          // Anthropic only
  | { type: "thinking_done"; content: string }
  | { type: "tool_start"; toolId: string; name: string; input: Record<string, unknown>; approvalId: string }
  | { type: "tool_complete"; toolId: string; output: string; success: boolean; elapsedMs?: number }
  | { type: "tool_cancelled"; toolId: string; reason: string }
  | { type: "subagent_start"; agentId: string; agentType: string }  // Claude subagents only
  | { type: "subagent_stop"; agentId: string }
  | { type: "mcp_init"; servers: Record<string, string>; tools: Record<string, string[]> }
  | { type: "turn_done"; usage?: ProviderUsage }
  | { type: "error"; message: string; code?: string }
```

`session.ts`'s event loop processes `ProviderEvent` instead of `SDKMessage`. It maps these to `SessionMessage` objects for scrollback/broadcast and accumulates `CanonicalToolCall` entries for canonical history.

---

## 4. Provider Implementations

### 4.1 ClaudeProvider

Wraps the existing `@anthropic-ai/claude-agent-sdk`. Internally maintains the same persistent `AsyncQueue` + `for await` consumer loop (needed for mid-turn interrupts). `runTurn()` pushes one message into the queue and returns a `TurnRun` whose `events` iterable closes after the SDK emits the `result` event for that turn.

**Tool call capture** — two existing intercept points in session.ts become canonical capture points:

1. `PreToolUse` hook: has `tool_use_id`, `tool_name`, `tool_input` → store input in `#pendingCanonical: Map<tool_use_id, CanonicalToolCall>`
2. `SDKUserMessage` processing: `tool_result` blocks have `tool_use_id` + `content` → complete the canonical record, emit `tool_complete` event

The `#toolUseIdToMessageId` correlation map already exists for scrollback; `#pendingCanonical` is a parallel map for the canonical capture.

**Auth**: SDK reads `~/.claude` credentials automatically when `ANTHROPIC_API_KEY` is unset (subscription). API key is passed via SDK options. No new auth code.

### 4.2 GeminiProvider

Uses `@google/genai` SDK. Executes tools itself via `tool-executor.ts` (see §4.4). Converts canonical history to Gemini `Content[]` format. Handles streaming via the SDK's async iterable. Emits normalized `ProviderEvent` objects.

**Auth**:
- `subscription`: Application Default Credentials via `gcloud auth application-default login` — SDK picks up `GOOGLE_APPLICATION_CREDENTIALS` or `~/.config/gcloud/application_default_credentials.json`
- `api_key`: pass to SDK constructor — also readable from `GOOGLE_API_KEY` env var

**Models**: Gemini 2.5 Pro/Flash and successors.

### 4.3 CodexProvider

Uses `openai` SDK. Executes tools via `tool-executor.ts`. Converts canonical history to OpenAI `ChatCompletionMessageParam[]`. Handles streaming via the SDK's `stream()` method.

**Auth**:
- `api_key`: standard `OPENAI_API_KEY` or config
- `subscription`: not currently supported via API (OpenAI's API requires API key); subscription-based Codex CLI is a future option

**Models**: GPT-4o, o3, o4-mini.

### 4.4 Shared Tool Executor (`tool-executor.ts`)

Used by GeminiProvider and CodexProvider. Implements the same file system operations as Claude Code's built-in tools:

```typescript
async function executeCanonicalTool(
  name: string,
  input: Record<string, unknown>,
  workdir: string,
  canUseTool: ToolApprovalFn,
): Promise<{ output: string; success: boolean }>
```

Tools implemented:
- `read_file` — `fs.readFile`, cat-n line numbering (matches Claude Code's Read output format)
- `write_file` — `fs.writeFile`
- `str_replace_file` — exact old→new string replacement (matches Claude Code's Edit)
- `multi_edit_file` — multiple replacements in one call
- `run_shell` — `child_process.exec` in `workdir` with timeout (matches Claude Code's Bash)
- `glob_files` — `fast-glob` (matches Glob)
- `search_in_files` — ripgrep fallback to grep (matches Grep)
- `list_directory` — `fs.readdir` with stat (matches LS)
- `spawn_subagent` — returns error ("not supported outside Claude provider")
- `mcp__*` — route to named MCP server via the session's active MCP connections

`canUseTool` is called before any write, exec, or destructive operation. Read-only tools (`read_file`, `glob_files`, `list_directory`, `search_in_files`) follow the session's mode-based auto-approve rules.

---

## 5. Session Changes

### 5.1 What moves out of session.ts

- `#ensureQueryLoop` + `#inputQueue` + `#consumerTask` + `#handleAgentMessage` → `ClaudeProvider`
- Tool approval state (`#pendingApprovals`) stays in `Session` (shared across providers)
- Scrollback, transcript, memory, ZeroID identity — unchanged

### 5.2 What session.ts gains

```typescript
// Canonical history — owned by the session, not any provider
#canonicalHistory: CanonicalTurn[] = [];

// Active provider — hot-swappable
#provider: AgentProvider;
#providerId: string;   // persisted to Store so restarts remember last provider

// Accumulated tool calls for the turn in progress
#inProgressToolCalls: Map<string, Partial<CanonicalToolCall>>;
```

`send()` becomes:
```
send(text) →
  build CanonicalTurn (user) → push to #canonicalHistory →
  provider.runTurn({ history: #canonicalHistory, userMessage: text, ... }) →
  consume TurnRun.events →
    text_delta/done   → build assistant SessionMessage (same as today)
    tool_start        → build tool_call SessionMessage (same as today) + stage canonical
    tool_complete     → complete tool_call + complete canonical
    turn_done         → finalize assistant CanonicalTurn, push to #canonicalHistory
```

### 5.3 Provider switching

```typescript
async switchProvider(
  providerId: string,
  model: string | undefined,
  sender: AuthContext,
): Promise<void>
```

1. Validate context window fit: `estimateTokens(canonicalHistory)` vs `targetProvider.contextWindow`
2. If > 95%: throw with actionable message
3. If > 80%: emit warning info message
4. Tear down current provider's loop (`provider.dispose()`)
5. Set `#provider` + `#providerId`
6. Persist to Store
7. Emit info message: `"⎆ Provider switched to Gemini 2.5 Pro. History has N turns. Next turn will re-seed the prompt cache."`

### 5.4 New CLI command

```
/provider                          → show current provider + per-turn attribution
/provider switch gemini            → switch to default Gemini model
/provider switch gemini gemini-2.5-pro → switch + explicit model
/provider switch claude            → switch back
/provider list                     → show configured providers + auth status
```

### 5.5 Protocol additions

`SessionInfo` gains:
```typescript
provider?: string;    // current provider id
```

Per-turn provider attribution is already in `CanonicalTurn` (stored in transcript). The scrollback `SessionMessage` for each assistant turn already carries the provider identity via `MessageIdentity.sub` (the agent URI for Claude; we extend this for other providers).

---

## 6. Configuration

```json
// ~/.codeoid/config.json
{
  "providers": {
    "claude": {
      "auth": { "type": "subscription" }
    },
    "gemini": {
      "auth": { "type": "api_key", "apiKey": "AIza..." },
      "defaultModel": "gemini-2.5-pro"
    },
    "codex": {
      "auth": { "type": "api_key", "apiKey": "sk-..." },
      "defaultModel": "gpt-4o"
    }
  },
  "session": {
    "defaultProvider": "claude",
    "defaultModel": "claude-opus-4-7"
  }
}
```

Env var overrides follow the same table-driven pattern as today:
- `GOOGLE_API_KEY` / `CODEOID_GEMINI_API_KEY`
- `OPENAI_API_KEY` / `CODEOID_CODEX_API_KEY`

---

## 7. File Structure

```
src/daemon/providers/
├── interface.ts          # AgentProvider, TurnOpts, TurnRun, ProviderEvent (~150 lines)
├── registry.ts           # ProviderRegistry — id → AgentProvider, initialize all at startup
├── canonical.ts          # CanonicalTurn, CanonicalToolCall, TOOL_NAME_MAP,
│                         # TOOL_OUTPUT_LIMITS, toAnthropicMessages(),
│                         # toOpenAIMessages(), toGeminiContents(), estimateTokens()
├── tool-schemas.ts       # JSON Schema definitions for all canonical tools
│                         # (used as function declarations in Gemini/Codex API calls)
├── tool-executor.ts      # executeCanonicalTool() — shared for Gemini + Codex
├── claude/
│   └── index.ts          # ClaudeProvider — wraps Claude Agent SDK, captures tool calls
│                         # (~400 lines, mostly extracted from session.ts)
├── gemini/
│   └── index.ts          # GeminiProvider — @google/genai, format conversion, tool dispatch
├── codex/
│   └── index.ts          # CodexProvider — openai SDK, format conversion, tool dispatch
└── index.ts              # barrel export
```

---

## 8. Implementation Phases

### Phase 1 — Foundation
- Define `interface.ts`, `canonical.ts` (types only, no converters yet)
- Extract `ClaudeProvider` from `session.ts` (pure refactor, no behavior change)
- Wire `Session` to use `ClaudeProvider` via the new interface
- All existing tests pass unchanged

### Phase 2 — Canonical capture
- Add `TOOL_NAME_MAP` and canonical capture in `ClaudeProvider`
- Session accumulates `#canonicalHistory`
- Add format converter `toAnthropicMessages()` (round-trip test: canonical → Anthropic → canonical)
- Tool output size limits enforced at capture time

### Phase 3 — Gemini provider
- Implement `GeminiProvider` with `@google/genai`
- Implement `tool-executor.ts` (read_file, str_replace_file, run_shell, glob_files, search_in_files, list_directory)
- Implement `toGeminiContents()` converter
- Add `tool-schemas.ts` with canonical function declarations
- `/provider switch gemini` works end-to-end

### Phase 4 — Codex provider
- Implement `CodexProvider` with `openai` SDK
- Implement `toOpenAIMessages()` converter
- `/provider switch codex` works end-to-end

### Phase 5 — UX polish
- `/provider` CLI command
- Context window overflow warnings + hard refuse
- Per-turn provider attribution in session info
- Telegram: `/provider` command via Grammy handlers
- Web UI: provider badge in session header

---

## 9. Open Tickets

- [ ] Recursive subagent tool capture (Task tool spawns sub-agents; capture their tool calls, not just the final output). Tracked separately.
- [ ] `/provider switch <name> --trim N` to drop oldest N turns before switching to a smaller-context provider.
- [ ] Gemini Ultra consumer subscription auth (ADC for Google One subscribers — different from service account ADC).
- [ ] Provider-aware auto-rotation: rotation should restart the CURRENT provider's backing session, not force back to Claude.
- [ ] Cost tracking per provider: `TurnUsage` already tracks cost per turn; add `providerId` column to the DB table.

---

## 10. The Rust Library Question

### Who actually needs provider format conversion?

| Service | Language | Needs conversion? | Reason |
|---|---|---|---|
| codeoid | TypeScript | **yes** | owns canonical history, drives provider switches |
| highflame-firehog | Rust | **yes** | `LLMProxy` already does OpenAI↔Anthropic; needs packaging + Gemini |
| highflame-cerberus | Go | **no** | has its own `NormalizedEvent` pipeline; never sees raw provider API formats |
| highflame-overwatch | TypeScript | **no** | receives IDE hook events (already parsed `PreToolUse`/`PostToolUse`); no raw API messages |

C FFI (CGo) is not needed anywhere — cerberus doesn't need the library, and overwatch is TypeScript. No cross-language bridge required.

### Recommendation

**codeoid implements the converters in TypeScript** — the format transforms are well-specified JSON operations, not compute-intensive, and don't justify WASM overhead. The TypeScript implementation lives in `src/daemon/providers/canonical.ts`.

**firehog extracts its existing `llm.rs` code into a standalone Rust crate** (`highflame-tool-canon`) — battle-tested production code becomes a reusable library for the Rust ecosystem. Firehog uses it as a native dependency. Scope: add Gemini conversion (currently absent), wrap `serde_json::Value` shapes in typed structs. No FFI targets needed.

The two implementations (TypeScript + Rust) are independent — the formats are a published spec (OpenAI, Anthropic, Google APIs), not proprietary. Staying in the native language of each consumer is the right call.

---

## 11. Research Audit Findings

Research conducted against LiteLLM, LangChain, Vercel AI SDK, and the Rust crate ecosystem. Key findings that affect our design:

### 11.1 Industry canonical format: OpenAI wins

Both LiteLLM and LangChain use **OpenAI's format as canonical** — everything converts to/from it. LangChain's `AIMessage.tool_calls` uses `{name, args, id}` (OpenAI-shaped). LiteLLM operates on OpenAI messages before provider-specific translation. Vercel AI SDK similarly centralises on a unified message shape close to OpenAI's.

**Implication**: our `CanonicalToolCall` field names should mirror OpenAI (`tool_call_id`, not `tool_use_id`; `arguments` as object not JSON string). When converting Anthropic→canonical we rename `tool_use_id`→`id`; when converting canonical→Anthropic we rename back.

### 11.2 Gemini has NO per-call IDs — critical design constraint

Gemini's `function_call` parts have **no unique call ID**. Matching relies on function name only. This is a known production problem (LiteLLM PR #16194 fixed a bug where parallel Gemini call indices reset to 0 per chunk).

**Implications for our design**:
- When capturing a Gemini turn: **generate our own UUID** for each function call and assign it as `CanonicalToolCall.id`. We own the ID space since Gemini doesn't provide one.
- When converting canonical history **to** Gemini format: **omit IDs entirely** in the `functionCall`/`functionResponse` parts — Gemini doesn't accept them. Match by function name in the same-turn pair.
- **Parallel same-function calls on Gemini are ambiguous**. If Gemini calls `read_file` twice in one turn, name-matching can't distinguish them. Mitigation: when executing tools for Gemini, process them sequentially and pair each result to the call by positional order within the same turn.

### 11.3 Anthropic's `is_error` flag has no OpenAI equivalent

Anthropic tool results accept `"is_error": true` as an explicit failure signal. OpenAI carries errors as string content only. When converting from canonical (which models Anthropic's richer semantics) to OpenAI format, serialize `success: false` results as `content: "Error: <output>"`. When converting OpenAI→canonical, any content starting with "Error: " is treated as `success: false`.

### 11.4 LiteLLM's sanitization checklist is our validation list

LiteLLM's `modify_params=True` sanitization handles exactly the real-world failure modes we will hit at provider switch boundaries. Our `validateCanonicalHistory()` must handle the same three cases:

1. **Orphaned tool call**: assistant turn has a `toolCall` entry but no corresponding result (e.g., session interrupted mid-turn before the tool executed). Fix: inject a dummy result `"[tool result unavailable — turn was interrupted]"`.
2. **Orphaned tool result**: a result references a `tool_call_id` that has no matching call in prior history. Fix: drop the orphaned result.
3. **Empty assistant content**: assistant turn has `content: ""` AND no tool calls. Fix: replace with `"[empty response]"` — Anthropic rejects truly empty assistant messages.

### 11.5 Arguments format: pre-parsed dict vs JSON string

| Provider | Arguments format on API |
|---|---|
| OpenAI | JSON **string** inside `function.arguments` |
| Anthropic | Already-parsed **object/dict** in `input` field |
| Gemini | Already-parsed **proto/dict** in `args` field |

Canonical stores arguments as **parsed object** (`Record<string, unknown>`). Converting to OpenAI requires `JSON.stringify(input)`. Converting from OpenAI requires `JSON.parse(arguments)`. Always do this in the converter, never assume the format is already right.

### 11.6 Rust crate landscape: extraction beats adoption

Candidates found:
- **`llm-connector`** (crates.io): 12+ providers, type-safe, function calling — but focused on thin provider abstraction, no canonical history conversion
- **`multi-llm`** (darval/multi-llm): provider-agnostic `UnifiedMessage` with tool calling — promising but underdocumented; conversion fidelity unknown
- **`litellm-rs`**: Rust port of Python LiteLLM — calls providers but does not expose the format conversion layer
- **`llm`** (graniet): broad provider support, `ChatMessage` type — unified traits but no explicit cross-provider history conversion

**None** have a battle-tested canonical history conversion layer with full multi-turn tool call round-trips. More importantly: **firehog's `src/gateway/llm.rs` already has exactly this** — bidirectional OpenAI↔Anthropic tool call conversion, `convert_tool()`, `convert_tool_choice()`, SSE streaming builders, and a declarative strip/inject config. It's been running in production.

**Recommendation**: The Rust library is an **extraction of firehog's existing code**, not a greenfield build. Package firehog's `llm.rs` converter logic as a standalone crate (`highflame-tool-canon`), add:
- Gemini ↔ canonical conversion (currently absent in firehog)
- Type-safe structs wrapping `serde_json::Value` (firehog uses raw `Value` throughout)
- C FFI header for cerberus (Go)
- WASM/napi build target for codeoid (TypeScript)

This is weeks of extraction work, not months of greenfield. The conversion logic is already proven.

### 11.7 Streaming tool calls: all three providers support it

- **Claude**: streaming `tool_use` blocks via the Agent SDK (already working in codeoid)
- **Gemini**: `@google/genai` ≥ 1.33.0 supports streaming function calls via `step.start`/`step.delta` events with `arguments_delta` accumulation
- **OpenAI**: `openai` npm package `stream()` method delivers `tool_calls[].function.arguments` as incremental string chunks

All three are implementable. Streaming tool inputs is display-only (arguments accumulate before execution); execution always waits for the complete input.

---

## 12. Audit Checklist (pre-implementation)

Before writing the first line of implementation code, verify:

- [x] Does `@anthropic-ai/claude-agent-sdk` expose `tool_use_id` in `PreToolUseHookInput`? — **yes** (session.ts line 890)
- [x] Does `SDKUserMessage` carry `tool_result` blocks with `tool_use_id`? — **yes** (session.ts line 2381)
- [x] Does Gemini's `@google/genai` support streaming tool calls? — **yes**, ≥ 1.33.0, via `step.start`/`step.delta` SSE events
- [x] Does the `openai` npm package support streaming tool calls? — **yes**, via `stream()` with incremental `arguments` chunks
- [x] Prior art for canonical LLM message normalization? — **yes**: LiteLLM (OpenAI as canonical), LangChain `AIMessage.tool_calls`, Vercel AI SDK `CoreMessage`
- [x] Existing Rust crates? — `llm-connector`, `multi-llm`, `litellm-rs` exist but none have battle-tested canonical history conversion; **firehog's `llm.rs` is the right extraction target**
- [ ] Confirm `@google/genai` ≥ 1.33.0 is installable and works under Bun (some Node-native packages have Bun compat issues)
- [ ] Confirm Gemini function calling works without call IDs in history replay — prototype a 3-turn tool-using conversation
- [ ] Prototype `validateCanonicalHistory()` with the three sanitization cases from §11.4 before wiring into session.ts
