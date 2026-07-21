# Dynamic Pack Loading — Design

> Status: **implementation** · Builds on [`sdlc-pipeline.md`](./sdlc-pipeline.md).
> Goal: let a user **discover, fetch, trust, and select** SDLC packs at runtime —
> from a git **registry** like [ai-factory](https://github.com/highflame-ai/ai-factory) —
> instead of only hand-editing `config.pipeline.packs` at boot.

---

## 1. Problem

Today a pack reaches codeoid exactly one way: `config.pipeline.packs = [{ dir, trusted }]`,
read once at boot by `createPipelineManagerFromConfig`. There is no way to add,
list, remove, trust, or select a pack at runtime, and no notion of *where a pack
comes from*. A user who wants the `aif-sdlc` methodology must clone the registry
by hand, find the pack subdir, edit JSON, and restart the daemon.

## 2. Model

Three concepts, mirroring the McpHub registry pattern but adding mutation +
persistence (the two gaps: `installPack` persists nothing; the MCP registry is
itself boot-only):

- **Registry** — a git repo laid out like ai-factory (`packs/<id>/pack.yaml`).
  Declared in `config.pipeline.registries = [{ name, url, ref? }]`. codeoid
  clones/pulls each into a local cache `~/.codeoid/packs/<name>/`.
- **Available pack** — a `packs/<id>/` directory found in a cached registry that
  is not yet installed. Discovered by enumerating `packs/*/pack.yaml`, or cheaply
  from a generated `packs/index.yaml` (added to ai-factory) without a full scan.
- **Installed pack** — a pack the user has committed to: its `dir` (+ `trusted`)
  lives in `config.pipeline.packs` and it is registered into the live
  `PipelineManager` so `pipeline.create({ pack })` resolves it.

`config.pipeline.defaultPack` is the **selected** pack — the one a pipeline runs
when created without an explicit `pack`.

## 3. PackService

`src/daemon/pipeline/pack-service.ts` — one always-constructed, lightweight
service (no DB, no runner), so a user can curate packs even before turning the
pipeline runtime on. It owns:

| Method | Effect |
| --- | --- |
| `listRegistries()` | configured registries + cache status |
| `addRegistry(url, name?, ref?)` | `git clone`/pull into the cache, persist to config |
| `refresh(name?)` | `git pull` a cached registry |
| `available()` | packs found across caches, not yet installed |
| `installed()` | loaded packs + metadata + trust + selected flag + status |
| `install(ref, { trusted })` | resolve a pack (registry `id` or explicit dir) → `loadPack` → persist to `config.pipeline.packs` → `installPack` into the live manager (if any) → link the registry's `skills/` into `~/.claude/skills` so the pack is *runnable* |
| `remove(id)` | unregister from the manager + drop from config |
| `trust(id, trusted)` | update config trust + reload the pack at the new trust |
| `select(id)` | set `config.pipeline.defaultPack` |

**Trust default is `false`** (decision): a fetched pack loads and its
skill/review gates work, but its shell `command` gates fail closed until an
explicit `trust`. Matches the sandbox zero-standing-privilege posture.

Persistence goes through one shared config mutator (`mutateConfigFile`) that
read → mutates → validates against `RootSchema` → atomically writes `0o600` —
reusing the settings-store path so config integrity is enforced in one place.

## 4. Wire protocol (additive — no `PROTOCOL_VERSION` bump)

New client verbs, replies `pipeline.pack.list.result` / `pipeline.snapshot`-style:

- `pipeline.pack.list` → `{ installed[], available[], registries[] }` — scope `pipeline:read`
- `pipeline.registry.add { url, name?, ref? }` — scope `pipeline:manage`
- `pipeline.pack.install { ref, trusted? }` — scope `pipeline:manage`
- `pipeline.pack.remove { id }` — scope `pipeline:manage`
- `pipeline.pack.trust { id, trusted }` — scope `pipeline:manage`
- `pipeline.pack.select { id }` — scope `pipeline:manage`

`pipeline:manage` is a **new owner-tier scope** (not in `OPERATOR_SCOPES`) —
these verbs rewrite `config.json`, same trust tier as `settings:write`.

## 5. CLI (`codeoid pack …`, commander in `src/cli.ts`)

```
codeoid pack registry add <git-url> [--name <n>] [--ref <ref>]
codeoid pack list                 # installed + available across registries
codeoid pack install <id> [--trust]
codeoid pack show <id>            # phases / roles / gates
codeoid pack trust <id> [--off]
codeoid pack select <id>
codeoid pack remove <id>
```

The CLI drives the daemon verbs when it is running; otherwise it mutates config
directly through the same `PackService` primitives (so `pack install` works
during image build / before `codeoid start`).

## 6. Web UX

A `/packs` slash command opens a **Pack Browser** (`web/src/components/PackBrowser.tsx`):
installed packs as cards (name · version · a visual phase pipeline · role badges
· gate markers · trust state · source), with *Set default · Start pipeline ·
Trust · Remove*; an **Available** section listing registry packs with *Install*;
and *Add registry…*. A pack selector is also added to the New-Session modal.

## 7. Forge (follow-up slice)

codeoid has git access in the sandbox, so a Forge sandbox fetches the ai-factory
registry at start via a `packs`/`registries` field on `HarnessDef` → resolved
into `WorkspaceSpec` env → codeoid config. Git auth follows the sandbox posture
(short-lived / SSH, never a long-lived env credential). Baking the registry into
the image remains the fallback for network-restricted egress bundles.

## 8. Non-goals (here)

- Dynamic **MCP-server** provisioning from dev/saas into the sandbox — a
  separate follow-up feature.
- Per-tenant pack scoping — packs stay daemon-global (managed at the owner tier)
  for now, like the MCP registry.
