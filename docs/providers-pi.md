# pi as a codeoid backend

codeoid can run sessions on [pi](https://pi.dev) — the extensible coding agent from earendil-works — as an alternative to Claude Code.
One codeoid session maps to one warm `pi --mode rpc` subprocess; pi keeps its own durable session tree on disk and codeoid resumes it across daemon restarts.

## Setup

1. Install pi and log a provider in (`pi /login`), or export an API key pi understands:

   ```bash
   npm install -g @earendil-works/pi-coding-agent
   pi   # first run: pick a provider, sign in
   ```

2. Nothing else. The `pi` backend is registered by default; create a session with it:

   - **Web UI**: New session → Backend → `pi`
   - **Wire**: `session.create` with `providerId: "pi"`

Config knobs (all optional, `~/.codeoid/config.json`):

```jsonc
{
  "providers": {
    "pi": {
      "enabled": true,      // false removes pi from the catalog
      "command": "pi"       // wrapper script or absolute path
    }
  }
}
```

## What works

| pi feature | codeoid surface |
| --- | --- |
| Streaming text + thinking | Normal transcript rows |
| Tool calls | codeoid's approval flow — modes (interactive/guarded/autonomous), budgets, `session.approve`, audit log |
| **pi extensions** (`~/.pi/agent/extensions`, `.pi/extensions`) | Hooks run inside pi unchanged. Extension dialogs (`ctx.ui.select/confirm/input/editor`) surface as codeoid dialogs (`session.ui_request`); `ctx.ui.notify` becomes an info/system row |
| Extension slash commands, prompt templates, skills | `session.commands` catalogs → the `/` palette; `/name args` passes through for pi to expand |
| Model switching | `/model provider/model-id` (catalog reported after the first turn) |
| Mid-turn sends | codeoid `now`/`next` → pi steering; `later` → pi follow-up |
| Session resume | pi's session file is the backing id; daemon restarts `switch_session` back into it |
| Rotation (`/rotate`) | `new_session` — fresh pi context, same codeoid session |
| Usage/cost | Per-turn deltas from pi's session stats |

## How tool approval works (the bridge)

pi ships **no built-in permission system** — gating is delegated to extensions.
codeoid injects a small bridge extension (`pi -e …`, regenerated per session) that hooks pi's `tool_call` event and routes every tool through codeoid's `canUseTool` gate before pi executes it.
Denials block the tool inside pi; approval-form patches (`patchableKeys`) merge into pi's live tool input.
The bridge announces itself on session start; **if it fails to load, turns fail closed** rather than running tools ungated, and any tool that somehow executes without passing the gate is flagged loudly in the transcript.

## Limitations

- pi extension **custom TUI components** (`ctx.ui.custom()`, custom renderers/editors/themes) don't cross RPC — pi degrades them itself; everything logic-level keeps working.
- The model catalog and command list populate after the first turn of a pi session (no idle subprocess just to list them).
- The pi subprocess inherits the daemon's environment (pi needs its keys); env hardening parity with the Claude subprocess is a follow-up.
- With an Anthropic **subscription** (OAuth) login, pi sends Claude-Code identity headers and pins the first system block — that's pi upstream behavior, not codeoid's.
- codeoid memory/recall and the conductor fleet tools are Claude-session features today.
