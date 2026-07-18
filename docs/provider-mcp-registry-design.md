# Registry-driven MCP mounter

Status: proposed (design gate for the implementation PR).
Author: codeoid.
Related: `docs/provider-codex-design.md`, `#178` (Verbatim Working Set), the codex `mcpServer/elicitation/request` fix (PR #196).

---

## 1. Problem

codeoid runs six backends — claude, codex, gemini-cli, pi, openai, gemini — and each takes MCP servers a different way.
Today only ONE MCP server is mounted consistently across all of them: codeoid's own `codeoid_memory`.
Everything else diverges:

- **User-configured MCP servers are Claude-only.** `loadUserMcpServers` reads `~/.claude.json` (`mcpServers` + per-project `projects[workdir].mcpServers`) and is called *only* in the claude provider.
- **codex and gemini-cli** silently rely on whatever their own native config files (`~/.codex/config.toml`, gemini `settings.json`) happen to contain — codeoid neither owns nor sees those.
- **pi, openai, gemini** get *nothing* beyond codeoid's in-process memory tools: they are model APIs driven by codeoid's own tool-loop and have no MCP client at all.

Two concrete costs of this drift:

1. **A user's MCP servers work on claude and vanish when they switch a session to codex or openai.** That breaks the core promise of a meta-harness — "swap the backend, keep the capability".
2. **Approval/trust diverges per backend.** The codex `mcpServer/elicitation/request` bug (PR #196) is the canonical example: an MCP tool call took a backend-specific approval path that never reached codeoid's shared `isSafeTool`/`canUseTool` gate, so read-only recall was auto-denied in guarded/interactive mode. Every per-backend approval path is a place for the next such divergence to hide.

## 2. Goals / non-goals

**Goals**

- A single **canonical MCP registry** in codeoid config — the one source of truth for which servers exist, declared once, transport-neutral.
- **Seamless across all six backends**: the same server, the same tools, the same names, the same approval behaviour, whichever backend a session runs on.
- **Uniform trust + approval**: every MCP tool call — on every backend — flows through codeoid's `isSafeTool`/`canUseTool` gate, keyed by one canonical `mcp__<server>__<tool>` name.
- **Per-session tenant scoping** reusing the mechanism `codeoid_memory` already proves (a per-session bearer token / injected context bound to `{workspace, session}`).
- **First-class fit with the memory model**: `codeoid_memory` becomes the reference registry entry; VWS demand-paging is unchanged.
- **Hot-reload, health, observability** owned by the daemon, since the daemon owns the connections.

**Non-goals (this iteration)**

- MCP *prompts* and *resources* (only *tools* are surfaced today; the registry is structured to add them later).
- OAuth/interactive MCP auth flows (handled by the native-passthrough escape hatch, §7).
- Replacing each backend's ability to *also* read its own native MCP config (we reconcile, we do not forbid — §8).

## 3. The two mount models (why one adapter shape is not enough)

Backends fall into two structurally different groups, and the registry must serve both:

| Model | Backends | Who owns the MCP client | How a server is delivered today |
| --- | --- | --- | --- |
| **A — backend owns the client** | claude, codex, gemini-cli | the backend / its SDK | claude: in-process `createSdkMcpServer` + SDK `mcpServers`; codex: `-c mcp_servers.<n>.*`; gemini-cli: ACP `session/new.mcpServers` |
| **B — daemon owns the client** | pi, openai, gemini | **codeoid** | `tool-loop.ts` calls `def.run()` in-process; there is no MCP client at all |

Model A backends want a *config*; Model B backends need codeoid to *be* the MCP client and expose the tools as function-calling declarations.

`codeoid_memory` already ships on both models — in-process for claude, URL-mounted to the shared `MemoryMcpHttp` endpoint for codex/gemini-cli, and executed in-daemon in the tool-loop for pi/openai/gemini.
So a registry that spans all six is a *generalisation of a pattern that already works end to end*, not a leap.
The one thing `codeoid_memory` never needed — because its tools are codeoid's own in-process code — is a general MCP *client* for arbitrary external servers.
That client is the load-bearing new component (§5.2).

## 4. Architecture

```
                       ┌──────────────────────────────────────────┐
   config.mcpServers ─▶│              McpRegistry                  │  source of truth
   (+ built-in memory) │  normalized entries: {name, transport,    │  (validated, hot-reloadable)
                       │   scope, trust, allowlist, enabled}       │
                       └───────────────┬──────────────────────────┘
                                       │
                 ┌─────────────────────┴──────────────────────┐
                 ▼                                             ▼
        ┌──────────────────┐                         ┌───────────────────────┐
        │  McpHub (daemon) │  owns ONE client per    │   per-provider          │
        │  clients: stdio  │  server, shared across  │   McpMounter adapters   │
        │  + streamableHTTP│  sessions; per-session  │  A: emit backend config │
        │  initialize/list │  scope injected at call │  B: register into loop  │
        │  /call, health,  │  time                   │  + execute via McpHub   │
        │  reconnect, OTEL │                         └───────────────────────┘
        └──────────────────┘
                 │
                 ▼
        canonical name `mcp__<server>__<tool>`  ─▶  isSafeTool / canUseTool  (ONE gate, all backends)
```

Four pieces:

1. **`McpRegistry`** — parses/validates the config `mcpServers` block plus the built-in `codeoid_memory` entry into normalized, transport-neutral `McpServerSpec`s. Hot-reloadable.
2. **`McpHub`** — the daemon-owned MCP client pool. One connection per server (stdio subprocess or streamable-HTTP session), shared across sessions, with per-session scope injected per call. Owns `initialize`/`tools/list`/`tools/call`, health, reconnect/backoff, per-call timeouts (reusing `session.mcpToolTimeoutMs`), and OTEL spans.
3. **`McpMounter` (per provider)** — the adapter that turns registry specs into that backend's mount: Model A emits native config; Model B registers function-tool declarations and routes execution through `McpHub`.
4. **Normalization layer** — one function that maps every backend's tool-name spelling to the canonical `mcp__<server>__<tool>` and one that resolves a spec's `trust` into the `isSafeTool` decision. This is the anti-drift core; the codex fix is its first client.

## 5. Key decisions

### 5.1 Daemon owns the client by default (the load-bearing decision)

Two candidate strategies:

- **(A) Sync config into each backend's native MCP config** and let each backend run its own client.
- **(B) codeoid owns one MCP client per server and exposes the tools uniformly** to every backend.

We choose **(B) as the default**, with (A) available as an explicit per-server escape hatch (§7).

Rationale:

- **It is the only option that reaches Model B backends at all.** A sync-config-only registry gives pi/openai/gemini nothing, because they have no MCP client — the exact seamlessness gap we are trying to close.
- **Uniform trust/approval.** One client means one place tool calls are gated (`isSafeTool`/`canUseTool`), instead of N backend-specific approval paths (the class of bug PR #196 fixed).
- **Uniform tenant scoping, telemetry, health.** One connection per server, scoped per session at call time, with one OTEL span shape and one health/reconnect policy — none of which is achievable when the config lives inside a subprocess we do not observe.
- **It matches what `codeoid_memory` already does**, so the memory model (§9) is a special case, not a bolt-on.

Cost of (B): codeoid must implement real MCP client transports (§5.2).
This is a bounded, well-understood build and is the same investment Omnigent made.

### 5.2 The general MCP client (`McpHub`)

New component: a transport-neutral MCP client owning two transports.

- **stdio**: spawn `command args` with `env`, frame newline/Content-Length JSON-RPC (codeoid already has `jsonrpc-stdio.ts` for the codex/pi/ACP RPCs — reuse its framing).
- **streamable-HTTP**: POST JSON-RPC to `url` with `headers` (+ bearer from an env var, never argv — the pattern `MemoryMcpHttp` already uses). Single-JSON responses; no server-initiated SSE required (verified sufficient against codex's rmcp client in PR #196).

Lifecycle per server: lazy `initialize` on first use → cache `tools/list` → `tools/call` on demand → health-check + reconnect with backoff → teardown on registry change or daemon stop.
One client instance per server, reference-counted across sessions.
Per-session scope (`{workspace, session}`, tenant headers) is passed at `callTool` time, not baked into the connection — so one warm connection serves every session safely.

### 5.3 One canonical name, everywhere

Every tool is keyed as `mcp__<server>__<tool>` regardless of backend:

- claude already uses this exact form;
- codex is normalized to it (PR #196);
- gemini-cli reports `<server>__<tool>` (double underscore, no `mcp__`) — `isSafeTool` already accepts that variant, and the registry canonicalizes it;
- Model B backends are named by codeoid directly (already `<server>__<tool>` via `namespacedMemoryToolName`).

`isSafeTool` + `#shouldAutoApprove` are the single gate; the registry's `trust` field feeds them (§6).

## 6. Config schema

A new `mcpServers` block in codeoid config (transport inferred, mirroring the shape users already know from `~/.claude.json` and Omnigent):

```yaml
mcpServers:
  github:
    command: npx                       # stdio: command present
    args: ["-y", "@modelcontextprotocol/server-github"]
    env: { GITHUB_TOKEN_ENV: GITHUB_PAT }   # values are ENV VAR NAMES, resolved in-daemon; never inline secrets
    trust: prompt                      # readonly | prompt (default: prompt)
    tools: [search_repositories, get_file_contents]   # optional allowlist; omit = all
    scope: workspace                   # global | workspace | session (default: workspace)
    backends: [claude, codex, openai]  # optional; omit = all backends
    enabled: true
  linear:
    url: https://mcp.linear.app/mcp    # http: url present → streamable-HTTP
    bearerTokenEnv: LINEAR_API_KEY
    native: false                      # true = escape hatch: sync into backend's own config, don't proxy (§7)
```

Notes:

- **Transport inferred** (`command` → stdio, `url` → http), exactly like the existing `parseMcpServerConfig` and Omnigent.
- **`trust`** is the anti-drift knob: `readonly` → auto-approve on all backends (like the memory tools); `prompt` → always gate. Per-tool overrides can be added later.
- **`tools`** allowlist filters what is surfaced to the model (Omnigent parity), enforced centrally in `McpHub`.
- **`scope`** controls the tenant binding passed at call time.
- **`backends`** lets an operator restrict a server to specific harnesses.
- **`native`** opts a single server out of proxying (§7).
- `codeoid_memory` is injected as a built-in entry (`trust: readonly, scope: session, alwaysOn`); it is not user-declarable.

## 7. Native-passthrough escape hatch

Some servers must run in the *backend's* trust context — e.g. an MCP server that does its own interactive OAuth in the user's `~/.codex`.
For those, `native: true` tells the registry to *sync the config into that backend's native store* (Model A only) and skip daemon proxying.
This is strictly opt-in; the default (proxy-through-`McpHub`) is what gives uniformity.
Native-passthrough servers do NOT reach Model B backends (documented limitation — they have no native config to sync into).

## 8. Native-config reconciliation

To be a true single source of truth without forbidding native config:

- For proxied servers, codeoid mounts them itself; it does not need to touch native files.
- To avoid *double-mounting* (a server in both the registry and `~/.codex/config.toml`), the registry name space is authoritative: on a name collision the registry wins, and codeoid logs the shadowed native entry rather than silently unioning.
- Operators who want the registry to be the *only* source can run codex/gemini-cli under a codeoid-managed home (dedicated `CODEX_HOME`) so native config is empty by construction. This is a deployment choice, not a requirement.

## 9. Memory model — the registry *is* the memory model, factored out

The registry does not threaten the VWS/memory design; it generalizes it.

- `codeoid_memory` becomes a built-in `McpServerSpec` (`transport: in-process-engine`, `trust: readonly`, `scope: session`, `alwaysOn: true`). Its tools (`recall`, `get_episode`, …) run in-process exactly as today — a third `McpHub` transport (`in-process`) whose `callTool` dispatches to `memoryToolDefs`.
- **VWS is unchanged.** `supportsMemoryTools` (the gate deciding compact-session-map vs transcript seed) generalizes to "is the memory entry mounted for this backend"; demand-paging semantics do not move.
- **Tenant scoping is inherited**, not reinvented: the per-session `{workspace, session}` binding the memory endpoint mints is the same scope every proxied server gets at call time.
- **Approval is already unified for the hard case** (codex, PR #196); every other server rides that seam.

## 10. Lifecycle, health, observability

- **Connection pooling**: one warm client per server, ref-counted; idle servers can be torn down on a TTL.
- **Hot-reload**: a registry change (add/remove/edit) reconciles live — new servers connect lazily, removed servers are torn down and unmounted from active sessions on their next turn. The daemon owns state, so no restart is needed.
- **Timeouts**: per-call wall-clock via the existing `session.mcpToolTimeoutMs`; a hung tool surfaces as an error result, never a wedged turn.
- **Health**: `initialize`/`ping` failures mark a server degraded; its tools are hidden with a one-line reason rather than presented and failing.
- **Observability**: one OTEL span per `tools/call` (`server`, `tool`, duration, outcome), one code path — impossible when the call happens inside an unobserved subprocess.

## 11. Security

- **Fail-closed**: no gate wired, unknown server, unresolved scope → deny (the `MemoryMcpHttp` and codex-fix posture).
- **Secrets by env-var name, never inline / never argv**: `env`/`bearerTokenEnv` reference variable *names* resolved in-daemon (the `MEMORY_MCP_TOKEN_ENV` pattern). Agent subprocesses keep the `buildAgentEnv` allowlist (GHSA-38vh vector 3) — the daemon injects only the specific tokens a mounted server needs.
- **Allowlist + trust are enforced in `McpHub`**, not per backend, so a look-alike name or a future write-capable tool cannot bypass confirmation on one backend while being gated on another.

## 12. Better than Omnigent — structurally and in implementation

Omnigent (Databricks, open-sourced 2026-06) declares MCP servers once in agent YAML under `tools`, infers transport (`command`/`url`), supports a per-server tool allowlist, and — structurally — the daemon owns the MCP client and exposes tools uniformly.
We match that and go further:

| Dimension | Omnigent | codeoid (this design) |
| --- | --- | --- |
| Source of truth | per-agent YAML `tools` | daemon config `mcpServers` **+ hot-reload across live sessions** |
| Client ownership | daemon owns client | daemon owns client (`McpHub`) — same model |
| Approval | per-server allowlist | allowlist **+ one `isSafeTool`/`canUseTool` gate across all six backends, one canonical name** |
| Scoping | per-agent (static) | **per-session** tenant tokens `{workspace, session}`, one warm connection serving all sessions |
| Memory/context | not a first-class concept | **`codeoid_memory` is the reference entry; VWS demand-paging built in** |
| Native config | not reconciled | explicit **reconciliation** (registry wins, native shadow logged) + opt-in native-passthrough |
| Backend coverage | terminal + SDK agents | all six, incl. in-daemon function-calling backends via the shared tool-loop |
| Observability | not specified | one OTEL span per tool call, health/degrade, per-call timeout |

Structural edge: Omnigent's config is *per agent* and *static*; codeoid's is *per daemon*, *hot-reloadable*, and *per-session-scoped*, because codeoid's clients-are-renderers architecture already centralizes state in the daemon.
Implementation edge: one gate, one name, one span, one timeout policy — the anti-drift core — versus per-harness handling.

## 13. Migration

1. Introduce the registry with `codeoid_memory` as a built-in entry; behaviour is identical (regression-safe).
2. Add config `mcpServers`; when non-empty, mount those servers via `McpHub` on every backend.
3. Fold claude's `loadUserMcpServers` into the registry as an *importer* (read `~/.claude.json`, emit registry specs) so existing Claude users keep their servers with zero config change, now available on every backend.
4. Deprecate the claude-only path once the importer is the default.

## 14. Implementation plan (vertical slices, each with a working state)

- **S1 — Registry + specs + config schema.** `McpServerSpec`, `McpRegistry`, `mcpServers` config block + validation; `codeoid_memory` modeled as the built-in entry. No behaviour change. Tests: parse/validate/normalize.
- **S2 — `McpHub` client.** stdio + streamable-HTTP + in-process transports; `initialize`/`list`/`call`; timeouts; health; per-session scope at call time. Tests: against a mock stdio server and a mock HTTP endpoint (reuse the PR #196 mock).
- **S3 — Model B wiring (openai/gemini/pi).** Generalize `executeMemoryToolCall` → `executeMcpToolCall(server, tool)` routing through `McpHub`; surface allowlisted tools as function declarations. This is the slice that closes the biggest gap. Tests: tool-loop with a mock server.
- **S4 — Model A wiring (claude/codex/gemini-cli).** Registry → SDK `mcpServers` (claude), `-c mcp_servers.*` (codex), `session/new.mcpServers` (gemini-cli); all keyed to the canonical name + shared gate. Tests per provider.
- **S5 — claude importer + reconciliation + hot-reload.** Fold `loadUserMcpServers`; native-config shadow logging; live add/remove.
- **S6 — observability + docs + `/settings` surface.** OTEL spans, health in the settings manifest, operator docs.

## 15. Testing strategy

- Unit: registry parse/validate/normalize; name canonicalization; trust→gate mapping.
- Component: `McpHub` against a mock stdio server + the PR #196-style mock HTTP endpoint (accept/deny/timeout/health).
- Per-backend: each `McpMounter` mounts a mock server and a tool call round-trips through the shared gate with the canonical name (claude via SDK fake, codex/gemini-cli via their fixtures, openai/gemini/pi via the tool-loop).
- Regression: `codeoid_memory` behaviour and VWS `supportsMemoryTools` unchanged; the codex elicitation path (PR #196) still auto-approves read-only tools.
- Opt-in integration: real codex/gemini-cli against a real external MCP server behind `CODEOID_INTEGRATION=1`.
