# Codeoid Conductor — Design Proposal

> Status: **DRAFT for grilling** · Author: design session 2026-06-30
> Goal: turn codeoid into a locally-running "master of my machine" personal
> assistant — one that takes natural-language instructions, controls and inspects
> every Claude/Gemini/codeoid session, remembers all threads of work, browses the
> web, and acts on the owner's behalf (email, etc.) — **without going out of
> context** and **without leaving the identity-native model.**

---

## 1. Goal & non-goals

**Goal.** A persistent *conductor* — a special codeoid session whose job is not to
do work but to **route** work: receive an instruction in natural language, decide
which existing session should handle it (or spawn a new one), dispatch, collect a
*compressed* result, remember it, and report back. It is the single front door to
the whole fleet.

**Non-goals.**
- Not a rewrite. The conductor is a thin layer over the existing
  `SessionManager` / `Session` / `AgentIdentityManager` primitives.
- **No OpenClaw runtime integration.** We borrow *ideas and code* from OpenClaw
  (channel adapters, skill/file conventions, scheduling) and reimplement them
  native to codeoid. We do not run OpenClaw as a sidecar. (See §10.)
- Not identity-optional. Every conductor action, and every action it delegates,
  is attributed to a ZeroID identity with a verifiable delegation chain. This is
  the whole point of building it *in codeoid* rather than in OpenClaw.

---

## Decisions locked (from grilling)

- **Authority = owner-delegated privileged agent.** The conductor is its own
  ZeroID agent identity; the owner delegates `session:*` to it; children are
  further delegations. One verifiable tree, one revocation root. Verified against
  `zeroid`: `delegation_depth` is a JWT claim, graph cap = 10, per-identity
  `max_delegation_depth` policy must be ≥3, and `handleMessage` gates on scope
  *membership* regardless of subject type — so an agent token carrying `session:*`
  passes the same gate a human does. (Grill R1)
- **Identity durability = durable conductor, disposable children.** Persist only
  the conductor's identity (survives restarts → one stable WIMSE URI for weeks).
  Conductor-spawned children are per-task workers that die with the turn. One
  credential at rest. (Grill R2)
- **Primary mode = coordinate the EXISTING session population.** The owner talks
  only to the conductor and directs it to act *in existing sessions*. Two session
  classes: (a) long-lived, user-owned sessions the conductor observes + directs;
  (b) disposable conductor-spawned workers. This makes cross-workspace **session
  tracking** (§6) the linchpin capability. (User refinement)
- **Routing safety = confirm before send-class acts.** `find`/`summary`/`recall`
  run silently; any send-class action to an existing user-owned session first
  proposes it with **repo + branch + content shown** and acts only on confirm.
  Near-zero wrong-repo risk. (Grill R3)
- **Egress trust (v1) = owner approval only, no Shield.** Send-class egress
  (`email.send`, external HTTP, outbound shell) is gated by owner approval via the
  existing `approvalId` flow, showing recipient + subject + body preview so
  approval is informed. Shield-like inspection is a deliberate *later* integration
  — the assistant must not depend on the local stack being up. (Grill R4 + owner
  follow-up)
- **Cost guard (v1) = metrics only.** No hard token budget or loop cap in v1; the
  event-driven idle model keeps it cheap and the existing metrics UI
  (tokens/cost/turns) gives visibility. A cheap per-instruction bounce cap is a
  low-cost later toggle; hard budgets ship with the Shield-era governance.
  (Grill R5)

---

## 2. The core principle — why it never goes out of context

A "master agent" fails the moment it tries to *do everything in one growing
context*. The conductor is built on three rules, all of which codeoid already
supports:

1. **The conductor holds an index, not transcripts.** It never ingests a child
   session's full output. Children return a *summary* (the existing memory /
   saliency-compression path — `buildMemoryMcpServer`, saar/extraction work in
   codeoid#39). The conductor's own context is: current instruction + a thin
   fleet index (session names, states, last-summary-per-thread) pulled on demand
   via tools.

2. **State lives in the daemon, not the conversation.** "Remember every thread"
   is a *query against durable state* (SQLite `store.ts` + the memory engine),
   not memory held in a chat. Codeoid already owns this: "sessions are
   daemon-owned; clients are stateless" (`CLAUDE.md`). The conductor is just
   another daemon-owned, resumable session.

3. **Long-running = resumable + event-driven, not one infinite turn.** The
   conductor wakes on an event (a child finished, a Telegram message, a cron
   tick), rehydrates from durable state, acts, and goes idle. Codeoid's
   `resumeSessions()` + transcript persistence make the conductor itself
   crash-proof and restartable. When its own context approaches the window, it
   self-summarizes into the fleet index and continues — the same compaction
   codeoid already does per session.

The net: the conductor's working set is **O(active threads)**, not
O(total history). That is the structural answer to "doesn't go out of context."

---

## 3. Where it sits in codeoid

Three additions, no architectural change:

| Addition | What it is | Mirrors existing |
| --- | --- | --- |
| **Conductor session role** | A `Session` created with `role: "conductor"` — same `query()` loop, but a different system prompt and an extra in-process MCP server bound to it. | normal `Session` |
| **`codeoid_fleet` MCP server** | In-process Agent-SDK MCP server exposing fleet tools (list / spawn / send / watch / summarize / interrupt sessions, recall across threads). Bound to the conductor session only. | `buildMemoryMcpServer` at `session.ts:810` |
| **Conductor identity grant** | The conductor's ZeroID agent identity additionally holds `session:*` scopes, so it can drive the fleet *as a first-class delegated authority* (see §4). | `AgentIdentityManager.registerSessionAgent` |

Injection point is already there: `session.ts:810` merges `codeoid_memory` into the
`mcpServers` passed to `query()`. The conductor adds `codeoid_fleet` the same way,
gated on `role === "conductor"`. One P3 gotcha: the Claude provider's
`allowedTools` currently allowlists only `mcp__codeoid_memory__*`
(`providers/claude/index.ts`) — it must be widened to admit
`mcp__codeoid_fleet__*` for the conductor session, or the mounted server's tools
stay unreachable.

---

## 4. Identity model — the crux

Today there are **two disjoint scope namespaces**:

- **Protocol scopes** (`protocol/scopes.ts`): `session:create|list|send|attach|
  watch|interrupt|approve|destroy`, `fs:read`. Held by **human/client** tokens.
  Enforced per inbound message in `SessionManager.handleMessage`.
- **Agent tool scopes** (`agent-identity.ts`): `tools:read|write|execute|agent`.
  Held by **agent** identities, delegated to sub-agents via RFC 8693
  (`tokens.delegate`, actor assertion, `act` chain, `delegation_depth`, scope
  intersection enforced by ZeroID).

The conductor blurs these: it is an **agent** that must exercise **`session:*`**
(a capability the model reserves for human clients). The proposed resolution —
which keeps everything identity-native:

**The conductor is a privileged agent whose authority is *delegated from the human
owner*, and every session it spawns is a further delegation.** The chain becomes:

```
human owner (ZeroID sub, IdP-verified)
  └─ delegate session:list,create,send,watch,interrupt  →  CONDUCTOR agent
        └─ delegate (per spawn)                          →  child session agent
              └─ delegate (attenuated)                   →  child sub-agents
```

Concretely:
- The conductor gets its own identity scope profile (`CONDUCTOR_SCOPES` in
  `agent-identity.ts`: `session:read` + `session:dispatch`, both protocol
  scopes) — deliberately **separate from** `AGENT_TOOL_SCOPES`, keeping the two
  namespaces disjoint, and deliberately excluding `tools:write`/`tools:execute`
  so the conductor's whole delegation subtree is read-only on targets. The
  conductor's token is minted by delegation from the owner, not handed the
  owner's own token. *(Implemented in P2.)*
- When the conductor spawns a child, the child's `created_by` is the
  **conductor's WIMSE URI**, and the child's token is `tokens.delegate`-d from the
  conductor — so `delegation_depth` increments (human=0 → conductor=1 → child=2 →
  sub-agent=3) and the `act` chain is fully verifiable.
- **Cascading revocation already does the right thing**: deactivate the conductor
  → every child + sub-agent token it minted dies by construction
  (`deactivateSessionAgent` cascades). Kill-switch for the whole fleet = revoke
  one identity.
- Each fleet tool call is audited under the conductor's WIMSE URI
  (`store.audit`), so "what did my assistant do at 3am" is a SQL query.

This is the identity-native payoff OpenClaw structurally cannot match: the master
agent and everything it touches sit on one verifiable delegation tree with one
revocation root.

---

## 5. The `codeoid_fleet` tool surface

In-process MCP tools (closure-bound to the conductor's auth + the
`SessionManager`), each gated on a `session:*` scope the conductor holds:

| Tool | Maps to | Scope |
| --- | --- | --- |
| `fleet_list` | `SessionManager` list path | `session:list` |
| `fleet_spawn(name, workdir, backend, brief)` | session create + delegated identity | `session:create` |
| `fleet_send(name, message)` | session send (async) | `session:send` |
| `fleet_summary(name)` | pull *compressed* latest state, not raw scrollback | `session:watch` |
| `fleet_interrupt(name)` | interrupt | `session:interrupt` |
| `fleet_find(query)` | resolve an NL reference → ranked session card(s) (see §6) | `session:list` |
| `fleet_recall(query)` | **cross-workspace** episode recall (see §6) | `session:list` |
| `machine_map()` | enumerate workspaces + git/running state (see §6) | `session:list` |
| `fleet_destroy(name)` | destroy | `session:destroy` (off by default) |

Key discipline: `fleet_send` is **fire-and-forget**; results come back as *events*
(§7), and `fleet_summary` returns a compressed digest. The conductor never slurps
a child transcript into its own window.

**Multi-backend.** `backend` selects Claude (native `query()`) or, via the
existing `anyagent` adapter (`.claude/` → Codex/Gemini/Hermes), a Gemini/Codex
child. The child is still a codeoid `Session` with its own ZeroID identity — so
"control a Gemini session" stays identity-native too.

---

## 6. Session tracking & recall — the core capability

This is the linchpin, not a side feature. Because the owner only ever talks to the
conductor, the conductor must resolve a *fuzzy natural-language reference* ("the
session where I was fixing the authz `latest_only` bug", "studio#870", "the durga
extraction eval") to the *right* session across every workspace on the machine —
and it must be right, because routing a command to the wrong repo's session is
harmful.

**Codeoid already has the right foundation.** The memory engine
(`memory/engine.ts`) is a hybrid retriever — its `RecallHit` carries
`components.{vector, fts, recency, pathOverlap}`, i.e. semantic (embeddings) **and**
keyword (SQLite FTS5) **and** recency **and** path-overlap, already blended. And
`IndexScheduler` + `buildWorkspaceIndex` already refresh indexes on a schedule.
Three extensions turn this into fleet-wide *session* tracking:

1. **Session-granular "cards" (new).** Per session, a durable card:
   `{ name, workspace/repo, workdir, branch, created, last_active, status, rolling
   summary of current work, salient entities (files, symbols, ticket ids, branch
   names) }`. Embed the card (semantic) and FTS-index its text (keyword). Retrieval
   returns *sessions*, not raw episodes.
2. **Cross-workspace scope.** Today `recall()` is bound to one `workspaceId` and
   excludes the current session. Add an `ALL`-workspace mode so the conductor
   searches the whole machine.
3. **Continuous cheap summarization.** Cards stay fresh via the saliency/extraction
   path (saar / codeoid#39) riding on `IndexScheduler` — the same investment that
   keeps the conductor's own context small keeps the cards current.

**Why keyword matters as much as semantic (your point).** Embeddings are weak on
exact identifiers — `studio#870`, `latest_only`, a branch name, a file path. FTS
nails those; embeddings nail "the session where I was frustrated with flaky auth".
The hybrid is what makes *both* queries land — which is exactly why we extend
codeoid's existing blended scorer rather than bolt on a pure vector store.

**Machine awareness.** A `machine_map` tool enumerates workspaces (repos under the
root), each session's workdir + git branch/status + running state — so the
conductor has "knowledge of the machine", not just of sessions.

**Cross-ownership.** Because the conductor's authority is *delegated from the owner*
(§4), it operates within the owner's tenancy and can therefore see + drive the
owner's own pre-existing sessions — not only ones it spawned. `getOwnedSession`
resolves against the owner's tenancy, so no ownership hack is needed.

---

## 7. Front door & wake model

- **Front door:** reuse the existing **Telegram frontend** (`frontends/telegram/`,
  embedded, direct `SessionManager` access). The owner DMs the bot; the message is
  routed to the conductor session. No new channel needed for v1. (Web UI cockpit
  remains the visual view.)
- **Wake model:** the conductor is event-driven. Wake sources:
  1. owner message (Telegram/Web),
  2. child-session completion (daemon emits an event → conductor turn),
  3. scheduled tick (a native cron, borrowed from OpenClaw's scheduler concept).
- **No busy-poll.** Between events the conductor session is idle (no tokens
  burned). This is both the cost story and the never-OOC story.

---

## 8. Acting on the owner's behalf (email, web, etc.)

- **Web lookup:** children already have `WebSearch`/`WebFetch`. The conductor
  delegates research to a child; gets a digest back.
- **Email / calendar / Slack:** native MCP servers (or borrowed adapters)
  registered as in-process MCP tools — **but never on the conductor directly for
  send-class actions.** Egress (`email.send`, shell, external POST) is delegated
  to a child whose token carries only that scope, and is gated (§9). The conductor
  *decides*; a narrowly-scoped child *acts*.

---

## 9. Security boundary — dogfood Highflame

"Master of my machine" = maximal blast radius. The owner runs an AI-agent
*security* platform; the conductor should be the flagship dogfood:

- **Per-identity Cedar policy**: what may the conductor do vs. a child vs. a
  sub-agent? Policy keyed on the WIMSE URI / `delegation_depth`.
- **Shield on egress** *(later phase — NOT v1)*: v1 egress is gated by owner
  approval only, per the R4 decision above. Once the assistant no longer needs
  to work with the local stack down, route `email.send` / shell / external HTTP
  through Shield so a prompt-injected child can't exfiltrate. Codeoid is already
  a `@highflame/sdk` consumer — a natural extension, not a new dependency.
- **Fail-closed defaults**: `fleet_destroy` and any send-class egress off unless
  explicitly granted; approvals surface to the owner via the existing
  permission-correlation (`approvalId`) flow.

The demo writes itself: *"I let an autonomous agent run my machine, and here is the
policy boundary + audit tree that makes that safe."*

---

## 10. What to borrow from OpenClaw (reimplemented native)

| OpenClaw concept | Borrow as | Why native |
| --- | --- | --- |
| Multi-channel adapters | optional extra `Frontend` plugins | codeoid's `Frontend` interface already exists; keep direct-`SessionManager` access |
| Skills/memory as plain files | a skills loader for the conductor | stays inside codeoid's `~/.codeoid/` data model |
| Scheduler / cron | native wake source (§7) | must mint identity-scoped tokens per run — can't outsource |
| "Orchestrate Codex workers" | the `backend` param (§5) via `anyagent` | every worker must get a ZeroID identity; OpenClaw workers don't |

The throughline: every borrowed capability must hang off a ZeroID identity. That
constraint is *why* we don't just run OpenClaw.

---

## 11. Build phases

1. **P0 — Conductor session + fleet read tools.** `role: "conductor"`,
   `codeoid_fleet` MCP with `fleet_list` / `fleet_summary` / `fleet_recall`
   (read-only). Identity grant = owner-delegated `session:list|watch`. Telegram
   routes to it. *Proves the loop without any spawn/act risk.*
2. **P1 — Spawn + dispatch.** `fleet_spawn` / `fleet_send` with full delegation
   chain + event-driven result digests. Cross-workspace recall (§6).
3. **P2 — Act on behalf.** Email/web/calendar via delegated, Shield-gated
   children (§8, §9). Cedar policy per identity.
4. **P3 — Multi-backend + scheduler.** `anyagent` backends; native cron wake.

---

## 12. Open questions (grill seeds)

1. **Identity authority (the crux).** Conductor as owner-delegated privileged
   agent holding `session:*` (§4) — or a different model (e.g. conductor *is* a
   client using a human-style token, no agent identity)? Does ZeroID's
   `delegation_depth` / `act` chain support human→conductor→child→sub-agent (depth
   3) cleanly today, or does that need work first?
2. **One conductor or many?** Single global conductor vs. one per context/project
   (isolation vs. cross-thread reasoning). Affects memory scoping and revocation.
3. **Memory: widen vs. new journal.** Add a global recall mode to the existing
   engine, or a separate `FleetJournal`? (§6)
4. **Spawn ownership semantics.** Is a conductor-spawned child "owned by" the
   conductor (dies with it) or re-parented to the human (survives conductor
   restart)? Revocation vs. durability tension.
5. **Egress trust.** Is Shield required in the loop for v1, or a P2 hardening?
   What's the minimum gate before `email.send` is allowed at all?
6. **Cost ceiling & runaway guard.** What stops a conductor↔child feedback loop or
   a forever-burning idle agent? Per-conductor token budget? Loop-detection?
7. **Front door scope.** Telegram-only for v1, or does the Web UI cockpit need a
   conductor pane too?
