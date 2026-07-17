# Codeoid web — roadmap

Active plan after the v1 cockpit landed. Each phase is committable independently.

---

## Phase 7A — `/mcp` `/agents` `/skills` discoverability  ·  ~1 day

The Claude Agent SDK already auto-loads everything from `~/.claude/` and
`<workdir>/.claude/`, so functionally these all work today. What's missing is
**surface** — letting the user *see* what's wired in without `cat`-ing files.

### Daemon

- `src/daemon/claude-config.ts` — pure helper that walks both `~/.claude/`
  and `<workdir>/.claude/`, returning a structured snapshot:
  - `agents[]`: name + description + path + scope (`global` | `workdir`),
    parsed from frontmatter (`agents/*.md`).
  - `skills[]`: name + description + path + scope, parsed from
    frontmatter (`skills/*/SKILL.md` or `skills/*.md`).
  - `mcpServers[]`: name + command + args + scope, parsed from
    `settings.json` `mcpServers` block.
  - `hooks[]`: event + matcher + command + scope.
- New protocol verb `claude.config { sessionId }` →
  `claude.config.result { agents, skills, mcpServers, hooks }`.
- Gate behind existing `session:list` scope (read-only, no new scope).
- Tests cover the parser against fixtures (a tiny `.claude/` tree under
  `src/tests/fixtures/`).

### Web

- `src/state/claude-config.ts` — signal-backed cache; refetches on
  `focusedSessionId` change. Daemon is canonical, no client state.
- `src/components/CapabilitiesDrawer.tsx` — right-side drawer matching
  the Identity drawer's style. Three tabs: **Agents** · **Skills** ·
  **MCP**, plus a fourth **Hooks** tab. Each row:
  - Name + description
  - Scope pill (`global` / `workdir`)
  - Path (mono, click-to-copy)
- New slash commands `/skills`, `/agents`, `/mcp`, `/hooks` → all open
  the drawer scrolled to the relevant tab.
- Add the "Capabilities" entry to the help modal (P7C will land that
  modal eventually).

### Risks

- Frontmatter parsing — keep it lenient (graceful fallback to filename).
- Watching for changes — v1 just refetches on session focus; no
  filesystem watcher.

### Acceptance

- `/mcp` opens a drawer listing every MCP server in `~/.claude/settings.json`
  + the workdir override, with paths.
- Same for `/agents` (subagent definitions) and `/skills`.
- All four tabs render even when the relevant directory is empty.

---

## Phase 7B — Shareable sessions MVP  ·  ~3-4 days

Goal: export a session bundle, fork it on another machine, continue work.

### Bundle format (manifest v1)

JSON manifest + tarball:

```
codeoid-session-<id>.tar.gz
├── manifest.json
├── transcript.jsonl       (one SessionMessage per line, ordered)
├── memory/
│   └── episodes.jsonl     (sliced from memory.sqlite — this session only)
├── turns.jsonl            (per-turn usage rows for cost/ctx history)
└── pinned/                (optional; pinned-files content snapshots)
    └── <relative path>
```

`manifest.json`:
```jsonc
{
  "version": 1,
  "exportedAt": "...",
  "exporterIdentity": { "sub": "spiffe://...", "name": "..." },
  "session": {
    "id": "<original-id>",
    "name": "shield",
    "createdAt": "...",
    "model": "claude-opus-4-7",
    "mode": "interactive",
    "rotationCount": 0
  },
  "workdir": {
    "alias": "github.com/highflame-ai/codeoid",   // derived from `git remote get-url origin`
    "originalAbsolute": "/home/yash/Workspace/codeoid",  // for diagnostics only
    "filePathPolicy": "alias-relative"
  },
  "counts": {
    "messages": 142,
    "episodes": 91,
    "turns": 14,
    "pinnedFiles": 2
  }
}
```

### Path portability

- Export rewrites every `file_paths[]` reference (in episodes + tool
  results) so absolute paths under the original workdir become
  `${alias}/<relative>`. Paths outside workdir get a `<external>/`
  prefix and a one-line note in the manifest.
- Import takes a `targetWorkdir` argument (or prompts the user) and
  reverses the rewrite — `${alias}/...` → `<targetWorkdir>/...`.
- Tool outputs that reference absolute paths in their text are kept
  verbatim but tagged with a `[from <alias>]` chip in the UI so the
  user knows they're historical, not interactive.

### Daemon

- `src/daemon/share/pack.ts` — produces the bundle. Emits a Buffer (gzip
  tarball) so we can stream over the WS or write to disk.
- `src/daemon/share/unpack.ts` — verifies manifest version, returns a
  staging directory for inspection before commit.
- `src/daemon/share/path-rewrite.ts` — pure helpers + tests.
- New protocol verbs:
  - `session.export { sessionId, includeMemory: bool, includePinnedFiles: bool, format: "url" | "inline" }`
    → returns `{ url, sizeBytes, manifest }` or `{ base64, manifest }` for
    bundles under ~5 MB.
  - `session.import { source: { kind: "file" | "url", value: string }, targetWorkdir: string, name?: string }`
    → returns the new `SessionInfo`.
- Bundle storage backend pluggable: v1 ships `file://` (daemon writes
  to `~/.codeoid/exports/`) and a thin S3 adapter behind a config flag.
  Signed-URL minting is out of scope for MVP.

### Web

- "Export" button on the session row context menu (right-click or
  three-dot icon) → opens an export modal:
  - Toggles for memory / pinned files
  - Format dropdown (download / copy URL / share-link)
  - Manifest preview
- "Fork from bundle" entry on the new-session modal → file picker (or
  paste a URL) → workdir-alias mapping prompt → submit.
- Forked sessions get a `forked-from: <alias>@<turn N>` badge in the
  session header.

### Risks

- **Secrets in tool output.** Bash tool outputs in the transcript may
  contain tokens, env vars, etc. v1 ships with a configurable redaction
  list (regex against tool output); v2 hooks Shield in for proper
  policy-driven redaction.
- **Size.** Cumulative episodes can be MBs; we cap inline export at
  5 MB and force file/URL backend above that.
- **Workdir alias collisions** when two repos share a remote URL (forks).
  Manifest stores `originalAbsolute` for disambiguation.

### Acceptance

- Export a 14-turn session locally, import it as a new session pointing
  at a fresh checkout, send a follow-up message — full prior context
  re-applies; cost/ctx counters resume from where the original ended.

---

## Phase 7C — GitNexus toggle  ·  ~half-day

Don't reimplement code intelligence — wire in [GitNexus][gn] as an MCP
server.

[gn]: https://github.com/abhigyanpatwari/GitNexus

### Daemon

- `src/daemon/mcp-installers/gitnexus.ts` — pure helper that:
  - Detects `gitnexus` on `$PATH` (or accepts a binary path via config).
  - Generates the MCP server entry for `<workdir>/.claude/settings.json`
    (or appends to existing `mcpServers` block).
  - Idempotent — running enable twice is fine; disable removes only the
    entry we wrote.
- New protocol verb (or repurpose `session.set_mcp { sessionId, name, enabled }`):
  - `session.toggle_gitnexus { sessionId, enabled }`.
  - On enable, writes the entry; on disable, removes.
  - Triggers an internal `session.rotate` so the next `query()` picks
    up the new MCP config.
- Gate behind `fs:read` (we're touching `<workdir>/.claude/settings.json`).

### Web

- A "Code intelligence" pill in the session header (next to mode/model):
  - Off (default): grayed pill
  - On: accent-colored "GitNexus" with a tooltip showing the MCP
    server's status from `claude.config` (the Phase 7A query).
- Click → toggle. Spawns a one-line system info message in the
  transcript: `[codeoid] GitNexus enabled — index will rebuild on first
  query`.

### Risks

- GitNexus binary not installed: the toggle surfaces a clear "install
  GitNexus first" inline help instead of silently failing.
- The first turn after enabling has a one-time index-build latency.
  v1 just notes this; v2 could pre-warm.

### Acceptance

- Toggle on; ask "where is `verifyToken` defined?"; Claude uses the
  GitNexus tool to resolve it and replies with a precise file+line.

---

## Sequencing

7A → 7B → 7C is the ROI ordering. 7A is shippable on its own.
7B has the biggest team-multiplier.
7C is small but waits on Phase 7A's `claude.config` snapshot to power
its status display.

Each phase commits to `main` directly per the user's
"push-when-tests-pass" preference for codeoid.
