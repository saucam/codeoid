# SDLC Pipeline — Design Proposal

> Status: **DRAFT for grilling** · Author: design session 2026-07-16
> Goal: give Codeoid a first-class, **optional**, **plugin-based**
> spec-driven-development pipeline — the durable, identity-aware, multi-provider
> host for a `spec → ship` workflow — where every phase, gate, and skill is a
> drop-in plugin you can add or remove without touching the daemon core.
>
> Prior art: [ADLC Toolkit](https://github.com/atelier-fashion/adlc-toolkit).
> Builds directly on: [`conductor-design.md`](./conductor-design.md),
> [`multi-provider-meta-harness.md`](./multi-provider-meta-harness.md).

---

## 1. Goal & non-goals

**Goal.** Ship SDLC-as-a-feature so a spec-driven pipeline (`/spec → /architect →
/validate → implement → /review → merge → /wrapup`) runs as a **durable,
daemon-hosted flow** with phase gates that can **halt awaiting human input**,
surface that halt to any frontend (Telegram / Web), be answered remotely, and
carry a **ZeroID audit trail per phase transition**. The pipeline can route
different phases to different providers (architect → Opus, implement → cheaper
model, review → a cross-provider panel).

**Non-goals.**
- **Not a rewrite, not a new methodology.** The pipeline is a thin layer over the
  existing `SessionManager` / `Session` / `Conductor` / `AgentIdentityManager`
  primitives. We do not invent an SDLC — we host one.
- **The daemon stays methodology-agnostic.** No ADLC phase names, templates, or
  "ethos" ship in the daemon core. Those live in a swappable **SDLC pack**
  (§3, §7). Codeoid gains a *generic pipeline primitive*; the process content is
  content.
- **We do not clone ADLC.** ADLC's skills already run unmodified inside a Codeoid
  session (they are just Claude Code skills). We adopt the methodology as content
  and upgrade the layers ADLC structurally can't do: durable orchestration,
  remote blocker approval, identity/audit, multi-provider.
- **No `pipeline-state.json` on disk as the source of truth.** ADLC's per-REQ
  state file is exactly what the daemon replaces — phase state is daemon-owned and
  survives restart (§5).

---

## 2. Prior art: ADLC Toolkit — what we take, what we beat

ADLC is a **methodology, not a runtime**: Claude Code skills + subagents +
templates symlinked into `~/.claude/`. No server, no auth, no persistence, no
remote access. Its value is the opinionated pipeline and the *knowledge
compounding* (lessons / validated-assumptions as first-class artifacts).

Its orchestration (`/sprint`) is built from **background Claude Code agents + git
worktrees + `pipeline-state.json` files + completion notifications**, with a
"Dynamic Workflows" engine used when available and a background-runner fallback.
That is precisely the brittle, single-machine substrate Codeoid already
out-classes.

| ADLC pain point | Codeoid already has the fix |
|---|---|
| `/sprint` = background agents + state-files + polling; dies on restart; no remote view | Daemon with **durable sessions that survive restart** (`SessionManager#resumeSessions`), scrollback replay, and the **Conductor** as a real orchestration substrate |
| Text-only dashboard in one terminal | **Web UI + Telegram** frontends — watch a pipeline, get blocker pushes, **approve from your phone** |
| No identity, no audit, no delegation | **ZeroID per-action attribution** (`audit_log`), agent+subagent identities, delegated/attenuated tokens, cascading revocation |
| Claude-only | **Multi-provider meta-harness** — per-phase provider routing + a **cross-provider review panel** |
| Local, terminal-bound, one operator | Remote, multi-frontend, multi-tenant control plane |

**What we adopt as content:** the phase sequence, the gate discipline
("Verify, don't trust"), knowledge artifacts (lessons/assumptions), and the
adversarial-review posture.

---

## 3. Positioning: three layers

The load-bearing architectural decision. Ship these as three separable layers so
the daemon never marries one methodology:

1. **Pipeline primitive (core, generic).** A daemon-owned, multi-phase flow: named
   phases, gates, per-phase provider/model, phase state persisted in the store,
   restart-survival, and a first-class **halt-awaiting-human** state that surfaces
   to frontends. Reusable for *any* staged process (release, incident runbook,
   data migration) — not just SDLC.
2. **Blocker-approval + audit (reuses what exists).** Halts route through the
   existing `approvalId` correlation + `ui_request`/`ui_response` channel and the
   `store.audit()` trail. Almost free — the seams already exist (§4).
3. **Capability packs (optional, swappable content).** ADLC-style phase
   definitions, skills, gates, and templates — **registered plugins**, installed,
   not compiled in. Users can fork them, replace them, mix them, or bring their own
   process manifest.

Ship (1) and (2) as the real engineering. (3) is curation + packaging — and its
extensibility is a **first-class requirement, not an afterthought** (§3a).

## 3a. Plugin architecture — the spine

**Design mandate: adding or removing a feature, phase, gate, or skill is a
drop-in operation — a file plus a registration call — never an edit to the daemon
core.** This mirrors patterns Codeoid already ships:

- Frontends: `daemon.use(new MyFrontend())` (the `Frontend` interface).
- Providers: `ProviderRegistry.register(id, factory)` (claude/gemini/openai/…).

The pipeline layer gets the **same treatment**, via four registries with identical
ergonomics. Every extension point is a small interface + a registry; nothing is
hardcoded.

### 3a.1 The registries

```typescript
// src/daemon/pipeline/registry.ts
interface PipelineRegistries {
  phases:  Registry<PhaseKind>;   // a *kind* of phase (how to run + interpret it)
  gates:   Registry<GatePlugin>;  // a reusable pass/fail predicate
  skills:  Registry<SkillPlugin>; // a runnable unit (slash-command / prompt / fn)
  packs:   Registry<Pack>;        // a named composition of the above
}

interface Registry<T extends { id: string }> {
  register(item: T): void;        // idempotent; last-wins with a warn on dup id
  unregister(id: string): void;   // remove a feature at runtime
  resolve(id: string): T | undefined;
  list(): T[];                    // discovery — powers `/pipeline caps`
  has(id: string): boolean;
}
```

### 3a.2 The four extension-point interfaces

```typescript
// A phase kind: knows how to execute one phase and read its result.
interface PhaseKind {
  id: string;                                   // "skill" | "panel" | "gate-only" | custom
  run(ctx: PhaseCtx): AsyncIterable<PhaseEvent>;
}

// A gate: a pure-ish predicate over a phase's output. Pluggable + composable.
interface GatePlugin {
  id: string;                                   // "has_acceptance_criteria", "tests_pass", …
  evaluate(ctx: GateCtx): Promise<GateVerdict>; // { pass: boolean; reason?; questions? }
}

// A skill: the runnable content a phase drives. THREE flavors, all equal citizens:
type SkillPlugin =
  | { id: string; kind: "slash";  command: string }         // an existing Claude Code skill (/spec)
  | { id: string; kind: "prompt"; template: string }         // an inline prompt template
  | { id: string; kind: "fn";     run: (ctx) => Promise<SkillResult> }; // native TS

// A pack: a named, versioned bundle that registers phases/gates/skills and
// declares a default phase sequence. Enable/disable a whole methodology at once.
interface Pack {
  id: string;
  register(r: PipelineRegistries): void;   // contributes its capabilities
  pipeline: PhaseDef[];                    // the default sequence (overridable per-run)
}
```

**Why this shape wins the "super configurable" goal:**

- **Add a skill** = write one `SkillPlugin` (or just point at a `/slash` command)
  and `skills.register(...)`. Zero core edits. An existing ADLC skill is a
  one-line `{ kind: "slash", command: "/review" }`.
- **Remove a feature** = `unregister(id)` or flip it off in config (§3a.3). No
  code deletion, no rebuild.
- **Swap a gate** = register a different `GatePlugin` under the same id, or
  reference a different id in the pack YAML.
- **Compose** = a pack is just a set of registrations + an ordered `PhaseDef[]`;
  mixing two methodologies is merging two `pipeline` arrays.

### 3a.3 Config-driven enable/disable (no code, no rebuild)

Everything registered is toggleable declaratively in `~/.codeoid/config.json`
(env-var overridable, same precedence rules as today). Nothing needs a redeploy to
turn a phase or pack on/off:

```jsonc
{
  "pipeline": {
    "defaultPack": "adlc",
    "packs": { "adlc": { "enabled": true }, "house-process": { "enabled": false } },
    "phases": {
      "review":   { "enabled": true, "skill": "review", "gate": "no_blocking_findings",
                    "panel": ["claude", "gemini"] },   // override a phase inline
      "canary":   { "enabled": false }                 // drop a phase entirely
    },
    "skills": { "disabled": ["optimize"] }             // remove a skill globally
  }
}
```

Resolution order for any capability: **per-run override → project `.codeoid/`
pack → user config → registered default.** A missing/disabled capability degrades
gracefully (the phase is skipped with an audited `phase.skipped` note, never a
crash) — the same "fall back to legacy behavior" discipline ADLC uses when a
config is absent.

### 3a.4 Discovery

`list()` on each registry powers a `/pipeline caps` command (CLI + Web + Telegram)
that shows every registered phase/gate/skill/pack and whether it is enabled — so
"what features do I have and how do I turn them on/off" is answerable at runtime,
not by reading source. (Analogous to ADLC's `adlc doctor` / catalog, but live.)

### 3a.5 Where packs come from

A pack is discovered from any of: (a) **built-in** (`packs/` in-repo, e.g. the
default `adlc`), (b) **user** (`~/.codeoid/packs/<id>/`), (c) **project**
(`.codeoid/pack/` in the repo under work — lets a repo pin its own process).
Discovery is filesystem + registration; installing a third-party pack is dropping a
directory, exactly like ADLC's symlink-based skill install but without the symlink
ceremony.

---

## 4. How it maps onto existing seams

The design is credible precisely because every load-bearing piece already exists.

### 4.1 The halt seam (load-bearing)

A phase gate that needs a human decision reuses the tool-approval fence:

- `Session#approve(approvalId, approved, sender, updatedInput)` — the gateway that
  unblocks a waiting turn (`session.ts`).
- `#waitForApproval(approvalId)` — the blocking fence inside `canUseTool`.
- `#pendingApprovals` — the resolver map; `#earlyApprovals` handles the
  decision-arrived-first race.
- For richer prompts (a validation-failure question with options, a merge-conflict
  choice), use the **`session.ui_request` / `session.ui_response`** channel
  (`SessionUiRequestMsg`, methods `select | input | editor | confirm`) rather than
  the boolean approve/deny. Pipelines mostly want `select`/`input`, not
  allow/deny.
- Every halt resolution is already audited: `store.audit(sender.sub,
  "session.approve" | "session.deny", sessionId, detail)`.

**Flow:** phase gate fails → pipeline emits a `ui_request` (blocker) →
`#broadcastToCapable(UI_DIALOGS, …)` pushes it to Telegram/Web → user answers from
any device → `ui_response` resolves the fence → phase resumes. This is the "answer
a blocker from your phone" story, and it is ~free on top of what ships today.

### 4.2 Identity & audit per phase

- `AgentIdentityManager.registerSessionAgent()` already mints a ZeroID identity
  per session; `registerSubagent()` issues **RFC 8693 delegated tokens** with
  scope attenuation and a verifiable `act` chain.
- Each pipeline **phase** dispatched as a worker gets a delegated, scope-attenuated
  token (e.g. the `implement` phase gets `tools:write`, the `review` phase gets a
  read-only profile). Deactivating the pipeline's conductor identity cascades
  revocation to every phase worker.
- Phase transitions write to `audit_log` (`subject` = phase-worker WIMSE URI,
  `action` = `pipeline.phase.<name>.<enter|pass|halt|fail>`), giving a
  fully-attributed, tamper-evident record of who ran what.

### 4.3 Orchestration via the Conductor

The Conductor (durable conductor identity, `session:dispatch` scope, `conductor` /
`worker` session roles, `role` column in the `sessions` table) is the orchestration
engine. A **Pipeline is a specialization of a conductor**: it holds a thin index
(phase states + last summary per phase), never ingests full phase transcripts,
spawns disposable per-phase workers, and routes send-class actions behind
confirmation — exactly the conductor's "index, not transcripts" principle. This is
what keeps a long pipeline from going out of context.

### 4.4 Per-phase provider routing + review panel

`Session#switchProvider()` and the `TurnOpts.model` per-turn override already let a
single session change backend at a phase boundary. The **review panel** fans a
phase out to N providers (Claude + Gemini + Codex) via the existing
`ProviderRegistry` and merges their findings — reviewer diversity ADLC can't do.

### 4.5 Cross-repo (defer to existing primitives)

ADLC's cross-repo REQ machinery maps onto Codeoid's `SessionManager#fork()` +
isolated worktrees. v1 stays single-repo; cross-repo rides on fork + conductor
worktree isolation in a later phase — no new mechanism invented here.

---

## 5. The pipeline primitive

### 5.1 State machine

```
draft → running ⇄ halted → { merged | failed | abandoned }
                    ▲
             (blocker: gate needs human)
```

A **Pipeline** is an ordered list of **Phases**. Each phase has: `id`, `name`,
`skill` (the slash command / prompt it runs), `provider?`, `model?`, `gate?` (a
predicate on phase output), and `onFail` (`halt` | `retry(n)` | `abort`).

```typescript
type PhaseState =
  | { status: "pending" }
  | { status: "running"; workerSessionId: string; startedAt: number }
  | { status: "halted"; requestId: string; reason: string; questions?: string[] }
  | { status: "passed"; summary: string; artifacts?: string[] }
  | { status: "failed"; reason: string; attempts: number };

interface PipelineState {
  id: string;
  name: string;                 // e.g. "REQ-091"
  spec?: string;                // path or inline
  phases: { def: PhaseDef; state: PhaseState }[];
  cursor: number;               // index of the active phase
  conductorSessionId: string;   // the pipeline's own durable session
  status: "draft" | "running" | "halted" | "merged" | "failed" | "abandoned";
  accountId: string;
  projectId: string;
}
```

### 5.2 Persistence & restart

Add a `pipelines` table (mirrors `sessions`: `id`, `name`, `account_id`,
`project_id`, `status`, `cursor`, `state_json`, `created_by`, timestamps). On
daemon restart, `resumePipelines()` runs alongside `resumeSessions()` — a pipeline
`halted` at phase 4 comes back **halted at phase 4**, with the blocker re-surfaced
to any attaching frontend via the existing pending-dialog replay in
`Session#attach()`. This is the concrete win over `pipeline-state.json`: no polling,
no stale files, survives process death, visible from anywhere.

### 5.3 Halt / resume

- On gate failure, the phase worker calls `requestUserInput` (→ `ui_request`); the
  pipeline marks the phase `halted`, persists, and broadcasts the blocker.
- On `ui_response`, the pipeline injects the answer into the halted phase's worker
  (surgical, like ADLC's `args.answers`), advances the fence, and continues. Every
  other phase's recorded state is untouched.
- Self-healing serialization (ADLC REQ-485) is **out of scope for v1** — a single
  human-answered blocker is the target; auto-rebase/merge-ordering is a later phase.

---

## 6. Protocol & scope additions

New client → daemon messages (additive):

```typescript
| { type: "pipeline.create"; name: string; spec?: string; pack?: string }
| { type: "pipeline.list" }
| { type: "pipeline.attach"; pipelineId: string }   // stream phase dashboard
| { type: "pipeline.answer"; pipelineId: string; requestId: string; value: string }
| { type: "pipeline.abort"; pipelineId: string }
```

Daemon → client:

```typescript
| { type: "pipeline.snapshot"; state: PipelineState }        // dashboard replay
| { type: "pipeline.phase_update"; pipelineId: string; phase: PhaseState }
| { type: "pipeline.blocker"; pipelineId: string; requestId: string; reason; questions }
```

New scopes (extend the existing 8): `pipeline:create`, `pipeline:watch`,
`pipeline:answer`, `pipeline:abort`. Blockers require `pipeline:answer`; a
read-only teammate gets `pipeline:watch` only — the same delegation/attenuation
story as sessions.

---

## 7. The default SDLC pack (content, not core)

The `adlc` pack is one `Pack` plugin (§3a.2) shipped in-repo — the daemon
hardcodes none of its names. It contributes its skills/gates and declares a default
sequence. The declarative face is a manifest that references **registered
capability ids**, so a pack is data, and authoring one is filling in a YAML file:

```yaml
# packs/adlc/pipeline.yaml
id: adlc
phases:
  - id: spec        ; kind: skill ; skill: spec       ; gate: has_acceptance_criteria
  - id: architect   ; kind: skill ; skill: architect  ; provider: claude ; model: opus
  - id: validate    ; kind: gate  ; gate: spec_valid  ; onFail: halt
  - id: implement   ; kind: skill ; skill: proceed    ; model: sonnet
  - id: review      ; kind: panel ; skill: review     ; panel: [claude, gemini, codex]
  - id: wrapup      ; kind: skill ; skill: wrapup
knowledge:                         # ADLC's compounding artifacts (pluggable store, §11 Q3)
  lessons: .codeoid/knowledge/lessons/
  assumptions: .codeoid/knowledge/assumptions/
```

`skill: spec` resolves through the **skill registry** — by default a
`{ kind: "slash", command: "/spec" }` plugin, but a project can re-register `spec`
as a native `fn` or a different prompt without editing the pack. `kind: panel` and
`kind: gate` resolve through the **phase-kind registry**. Swapping `adlc` for a
house process is editing YAML + dropping a pack directory (§3a.5) — never the
daemon.

---

## 8. File structure

```
src/daemon/pipeline/
├── interface.ts       # PipelineState, PhaseDef, PhaseState + the 4 plugin interfaces
│                      #   (PhaseKind, GatePlugin, SkillPlugin, Pack)
├── registry.ts        # PipelineRegistries — phases/gates/skills/packs (§3a.1)
├── manager.ts         # PipelineManager — create/list/resume/answer/abort; owns conductor sessions
├── engine.ts          # phase runner — resolve plugins, dispatch worker, run gate, halt/resume/advance
├── pack.ts            # load + validate a pack manifest (YAML → registrations + PhaseDef[])
├── store.ts           # pipelines table CRUD (or fold into daemon/store.ts)
├── builtin/           # default plugins — each a ~20-line file, drop-in
│   ├── phase-skill.ts #   PhaseKind "skill"
│   ├── phase-panel.ts #   PhaseKind "panel" (multi-provider review)
│   ├── gate-*.ts      #   built-in GatePlugins (has_acceptance_criteria, tests_pass, …)
│   └── skills.ts      #   registers the ADLC /slash skills as SkillPlugins
└── index.ts
packs/
└── adlc/pipeline.yaml # default pack manifest (content)
```

`PipelineManager` sits beside `SessionManager` and is registered the same way a
frontend/conductor is (`daemon.usePipelines(...)`); frontends get pipeline access
through `FrontendContext`. **A third party adds a capability by dropping a file in
`builtin/` (or their own pack dir) and calling `register()` — the engine discovers
it by id.** No switch statements, no core edits.

---

## 9. Implementation phases

1. **Pipeline primitive + registries (no methodology).** `PipelineState`,
   `pipelines` table, `PipelineManager`, `resumePipelines()`, **and the four
   registries with the plugin interfaces (§3a)**. A pipeline of one trivial
   registered phase runs, persists, and survives restart. The registry/plugin
   seam ships in phase 1 — extensibility is not retrofitted later.
2. **Halt / resume over frontends.** Wire a `GatePlugin` to `ui_request`; blocker
   surfaces to CLI + Telegram + Web; `pipeline.answer` resumes. **This is the thin
   first slice (§10).**
3. **Identity + audit per phase.** Delegated per-phase tokens; `pipeline.phase.*`
   audit rows; cascading revocation.
4. **SDLC pack loader.** YAML manifest → phases; ship the default `adlc` pack.
   Knowledge artifacts (lessons/assumptions) captured on `wrapup`.
5. **Multi-provider review panel.** Fan `review` across providers; merge findings.
6. **Dashboard UX.** Web pipeline dashboard + Telegram `/pipeline` commands
   (phase table, blocker cards, answer inline).
7. **(Later) parallel pipelines + cross-repo.** Multiple pipelines via the
   conductor; cross-repo via `fork()` + worktrees; ADLC-style merge-ordering /
   self-healing serialization.

---

## 10. Thin first slice (prove the substrate)

One phase, end to end:

> Run ADLC's `/proceed` as a **daemon-hosted pipeline session** where a single gate
> — `/validate` failing 3× — **halts and surfaces the blocker to Telegram**. Answer
> it from your phone; the pipeline resumes; every phase transition lands a ZeroID
> audit row.

If that slice feels better than ADLC's background-agent version (it will — restart
survival + remote answer + audit are all free on the existing seams), the rest is
incremental. If it doesn't, we've spent days, not weeks, to find out.

**Explicitly:** do **not** ship a shallow "SDLC mode" that is just prompt
templates. ADLC's value is the state machine + gates + knowledge compounding, not
the skill text. The durable pipeline primitive (layer 1) is the actual work and the
actual differentiator. Scope for that or don't start.

---

## 11. Open questions

1. **Halt channel: reuse `ui_request` vs. a dedicated `pipeline.blocker`?** Leaning
   `ui_request` for the transport (already replayed on attach) with a `pipeline.*`
   semantic wrapper. Confirm the `select`/`input` methods cover every gate.
2. **Is a Pipeline literally a Conductor session, or a sibling that drives
   conductors?** Leaning "specialization of conductor" so it inherits index-only
   context + dispatch + worktree isolation for free.
3. **Where do knowledge artifacts live** — per-repo `.codeoid/knowledge/` (ADLC
   style) or the daemon store (queryable across repos via the memory tools)? The
   memory-recall infra argues for the store.
4. **Gate predicates: declarative (YAML expression) or a skill that returns
   pass/fail?** Declarative is safer/inspectable; a skill is more flexible. Maybe
   both, like ADLC's `/validate`.
5. **Do phases share one worker session (provider-switch between phases) or one
   worker per phase?** One-per-phase gives clean identity/audit boundaries and
   parallelism; shared gives cheaper context continuity. Likely one-per-phase.
6. **Cross-provider review merge:** union of findings, or a judge phase that
   dedupes/ranks? (ADLC's adversarial-review posture suggests a judge.)
