# Conductor — Phased Build Plan

> Companion to [conductor-design.md](./conductor-design.md) (architecture +
> decisions) and [conductor-session-resolution.md](./conductor-session-resolution.md)
> (the retrieval deep-dive). Those two docs ARE the spec; this is the sequencing.

## Branch strategy

- **One feature branch off `main`: `feat/conductor`.** `main` is ruleset-protected
  (PR + CI required), so every phase lands as its own reviewable PR onto
  `feat/conductor` (or PRs straight to `main` if you prefer trunk-ish); the design
  docs are the first commit.
- Phases are **vertical slices** — each ends in a working, shippable daemon. No
  phase leaves the tree broken. Prefer merging a phase before starting the next.
- **P1 (retrieval) and P2 (identity) are independent subsystems** (memory engine vs
  ZeroID) — they can be built in parallel (two people / two worktrees) and only
  meet at P3.

## Sequencing principles (codeoid-specific)

1. **Measure before you tune.** The retrieval work is only trustworthy against a
   labeled eval set — build it first (P0).
2. **Contracts before consumers.** Card/fact schemas + the fleet protocol land
   before the conductor LLM or any client consumes them.
3. **Read before write.** Fleet *read* tools (list/find/summary) ship and bake
   before any *act* tool (send/spawn) — the blast-radius rule.
4. **The daemon owns state; clients are pure renderers.** Every capability is a
   daemon/protocol feature first; web, Telegram, and mobile are thin views over it.

---

## Phase overview

| # | Phase | Ships | Depends on |
|---|---|---|---|
| **P0** | Branch + eval harness + schemas | precision@1 baseline; card/fact schema; labeled set | — |
| **P1** | Session-resolution retrieval upgrade *(linchpin)* | fuzzy ref → right session, cross-workspace, sub-2s | P0 |
| **P2** | Conductor identity foundation | durable owner-delegated conductor identity | P0 |
| **P3** | Conductor session + read-only fleet tools | conductor can list/find/summarize the fleet | P1, P2 |
| **P4** | Dispatch + routing (send/spawn) | "continue the authz fix" → confirm → act; child digests | P3 |
| **P5** | Front doors: web + Telegram | conductor chat + separate switchable session list | P4 |
| **P6** | Act on behalf (email/web/calendar) | approval-gated egress via delegated children | P4 |
| **P7** | Mobile app contract + conductor screen | mobile renders conductor + session switcher | P5 |
| **P8** | Governance *(later)* | Shield egress, Cedar policy, budgets, loop cap | P4/P6 |

---

## P0 — Branch, eval harness, schemas

**Goal:** a fast deterministic feedback loop for the linchpin, plus the data
contracts everything else consumes.

**Slices**
- Create `feat/conductor`; commit the three design docs.
- **Labeled eval set**: ~40–60 `(NL reference → correct session_id)` pairs mined
  from your own codeoid history across repos (mix identifier-heavy + fuzzy). Store
  as a fixture.
- **Eval harness**: runs a resolver over the fixture, reports **precision@1 /
  MRR / recall@k** + p50/p95 latency. First target: current `searchSessions()`.
- **Schemas** (types + SQLite DDL, no behavior yet): `session_card`
  `{session_id, workspace, repo, branch, task, state, last_action, open_threads,
  entities, updated_at}`; `fact(subject, predicate, object, valid_at, invalid_at,
  created_at, expired_at, embedding)`.

**Exit:** `bun test` runs the eval; you have a **baseline precision@1 number** to
beat, and the card/fact tables migrate cleanly (verify against a real
`bun:sqlite`, not DDL strings).

---

## P1 — Session-resolution retrieval upgrade (the linchpin)

**Goal:** resolve a fuzzy reference to the right session, across all workspaces,
sub-2s — the capability the whole product hinges on. Pure memory-engine work;
benefits every client immediately, no conductor/identity risk.

**Slices (each independently testable against the P0 harness)**
- **1a — Embedder → BGE-M3.** New `Embedder` impl (ONNX/int8) behind the existing
  interface; persist **dense + learned-sparse** vectors (BGE-M3 emits both). Keep
  `bge-small-en` as the degraded fallback.
- **1b — Identifier-aware lexical.** Rebuild `episodes_fts` (+ new `cards_fts`)
  with a code/trigram analyzer + boosted id columns (ticket/branch/path). Add
  Stage-0 regex query-typing, Stage-3 exact-id override, and a deterministic
  entity boost.
- **1c — Session cards + facts.** Generate a card per session via
  **LFM2-350M-Extract** (grammar-constrained JSON) on `IndexScheduler` checkpoints;
  keep canonical with mem0-style ADD/UPDATE/invalidate reconciliation; record state
  changes as **bi-temporal facts** (invalidate-don't-delete).
- **1d — Cross-workspace mode.** `ALL` scope on `recall` / `loadVectorMatrix` /
  `ftsSearch` (today all `workspaceId`-bound).
- **1e — Cross-encoder rerank.** `bge-reranker-v2-m3` (ONNX-int8) over top-k cards.
- **1f — Fusion.** RRF (k=60) now; swap to TMM-normalized convex + α-by-query-type
  once the P0 labels justify it. Add recency/reinforcement/pinned priors.

**Exit:** precision@1 on the P0 set **beats baseline by the target margin**; p95
resolution **< 2s** on the Hetzner box; identifier queries (`studio#870`) and fuzzy
queries (`the version-scoping bug`) both land. This is the go/no-go gate for the
whole feature.

**Risk:** BGE-M3 CPU latency — mitigate with ONNX-int8 + offline batch embedding
(only the query embeds at request time). Verify tok/s on the actual box.

---

## P2 — Conductor identity foundation

**Goal:** an owner-delegated, durable, revocable conductor identity (design R1+R2).
Independent of P1 — build in parallel.

**Slices**
- Add a **conductor scope profile** granting `session:*` to an agent identity
  (extend `AGENT_TOOL_SCOPES`); register with a policy `max_delegation_depth ≥ 3`.
- **Delegate `session:*` from the human owner** to the conductor (not the owner's
  own token); verify the `human → conductor → child → sub-agent` chain mints at
  depth 3 against `zeroid` (cae_test confirms depth-3 works).
- **Durable identity**: persist the conductor's `identityId` + credential to the
  store; on `resumeSessions()`, reload rather than re-register (survives restart →
  one stable WIMSE URI). Children stay disposable.
- Verify **cascading revocation**: deactivating the conductor kills its subtree.

**Exit:** conductor identity persists across a daemon restart (same URI), holds
`session:*` via owner delegation, every fleet action audits under its URI, and one
`agents.deactivate` kills the whole subtree.

---

## P3 — Conductor session + read-only fleet tools

**Goal:** a single global `role:"conductor"` session that can *see* the fleet.
Read-only — no act/spawn risk.

**Slices**
- `role: "conductor"` on `Session`; conductor is discoverable + attachable like any
  session, and self-persists (durable identity from P2).
- **`codeoid_fleet` in-process MCP server** (mirror `buildMemoryMcpServer` at
  `session.ts:810`), injected only for the conductor: `fleet_list`, `fleet_find`
  (calls the P1 pipeline), `fleet_summary` (compressed, not raw scrollback),
  `fleet_recall`, `machine_map` (workspaces + git/running state).
- **Expose `fleet_find`/`fleet_list` over the daemon WS protocol too** (not only as
  conductor MCP tools) so *clients* get a search-powered session list later.

**Exit:** via CLI (`codeoid attach conductor`), "which session was the authz fix?"
resolves correctly across workspaces; conductor holds only an index, never raw
child transcripts.

---

## P4 — Dispatch + routing (send-class)

**Goal:** direct existing sessions and spawn disposable workers, safely.

**Slices**
- `fleet_send` (fire-and-forget to an existing session), `fleet_interrupt`,
  `fleet_spawn` (disposable child with a delegated identity from P2).
- **Routing safety (R3):** send-class to an existing user-owned session first
  proposes with **repo + branch + content shown**, acts only on confirm (reuse the
  `approvalId` correlation flow); reads stay silent.
- **Event-driven digests:** child completion emits an event → conductor turn
  receives a *compressed* result (never raw transcript) — the never-OOC guarantee.

**Exit:** "continue the authz `latest_only` fix in that session" → resolves →
confirms (right repo/branch) → sends; a spawned child's result returns as a digest;
conductor context stays O(active threads).

---

## P5 — Front doors: web UI + Telegram

**Goal:** talk to the conductor from web + Telegram; browse/switch any session
separately.

**Slices**
- **Web (SolidJS):** a **conductor pane** (attaches to the conductor session) +ADD a
  **session list** view with a search box wired to the protocol `fleet_find`/`list`
  (so the human gets NL session search too, not just the conductor LLM).
- **Telegram:** route DMs to the conductor session; `/sessions` lists + lets you
  switch/attach to any session (reuse the embedded `SessionManager` access).
- Both are thin `Frontend` plugins over the same daemon — no new state owner.

**Exit:** from web and Telegram you can (a) converse with the conductor and (b)
list + switch into any individual session; both stay in sync (daemon-owned state).

---

## P6 — Act on behalf (email / web / calendar)

**Goal:** the "master of my machine" surface, approval-gated (design R4).

**Slices**
- Integrations as **narrowly-scoped delegated children** (e.g. a Gmail MCP child
  holding only `email.send`), never on the conductor directly.
- **Owner approval gate** showing recipient + subject + body preview (informed
  approval, not theater).
- Web lookup delegated to children (they already have `WebSearch`/`WebFetch`);
  conductor gets digests back.

**Exit:** "email X the summary" → conductor drafts → approval with full preview →
send; research tasks delegated and returned as digests. **No Shield yet** (P8).

---

## P7 — Mobile app: conductor screen + session switcher

**Goal:** a codeoid mobile client — because clients are pure renderers, this is
mostly a new front end over the *existing* protocol.

**Slices**
- **Conductor screen** = attach to the conductor session (same protocol as web).
- **Session list** = `session.list` + the P3 protocol `fleet_find` search box,
  rendered as a separate, switchable list; tapping one attaches to it.
- Confirm-before-act (R3) and approval prompts (R4) render as native mobile
  confirmations over the `approvalId` flow.
- Contract check: ensure *every* conductor capability the mobile app needs is on
  the WS protocol (not trapped as in-process MCP) — this is why P3 exposes
  `fleet_find`/`list` over the protocol.

**Exit:** mobile app shows the conductor chat + a separate switchable session list;
switching sessions and approving actions work identically to web.

---

## P8 — Governance (later)

**Goal:** the deferred safety layer (design R4/R5 "later").

**Slices:** Shield on egress (fail-open to approval if down); Cedar policy per
identity / `delegation_depth`; per-conductor token budget + alert; cheap
per-instruction bounce cap (loop guard).

**Exit:** injected child cannot exfiltrate past Shield; runaway loop is capped;
spend has a ceiling. Great Highflame dogfood story.

---

## Dependency graph

```
P0 ──┬── P1 (retrieval) ──┐
     └── P2 (identity) ───┴── P3 (conductor + read) ── P4 (dispatch)
                                                          ├── P5 (web + telegram) ── P7 (mobile)
                                                          ├── P6 (act on behalf)
                                                          └── P8 (governance, later)
```

## Verification philosophy

Every phase states how you *know* it's done (exit criteria above). Two hard gates:
- **P1 exit is the go/no-go for the whole feature** — if fuzzy resolution isn't
  reliably sub-2s and precision@1-strong on your own history, nothing downstream
  matters.
- **Read-tools (P3) bake before act-tools (P4)** — never ship `fleet_send` before
  `fleet_find` is trustworthy.
