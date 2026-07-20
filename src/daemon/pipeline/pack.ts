/**
 * Declarative pack loader. A pack is a directory with a `pack.yaml` manifest
 * (docs/sdlc-pipeline.md §7) — DATA only, no executable code. `loadPack()` parses
 * and validates it, then compiles it into the runtime `Pack` shape (id +
 * register() + pipeline), so the daemon runs a shared, contributable methodology
 * by reading files rather than importing code. This is what makes a pack safe to
 * fetch from a shared registry: nothing executable travels with it.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  GatePlugin,
  Pack,
  PhaseDef,
  PhaseFailAction,
  PipelineRegistries,
  SkillPlugin,
} from "./interface";

// ── Manifest schema (the pack.yaml contract) ──────────────────────────────

const idField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "must be an alphanumeric id (._- allowed)");

/** A capability role (ai-factory `roles/*.yaml` format) — compiled to Cedar and
 *  enforced by Shield in a later slice; parsed + carried on phases now. */
export const roleSchema = z.object({
  name: z.string().min(1).max(64),
  summary: z.string().max(500).optional(),
  write: z.boolean(),
  network: z.union([z.boolean(), z.literal("read-only")]).default(false),
  envelope: z.union([z.literal("all"), z.array(z.string().max(32)).max(32)]),
  exceptions: z
    .record(
      z.string(),
      z.object({ add: z.array(z.string().max(32)).max(32).optional(), reason: z.string().max(500).optional() }),
    )
    .optional(),
});
export type RoleDef = z.infer<typeof roleSchema>;

const onFailSchema = z
  .union([z.literal("halt"), z.literal("abort"), z.object({ retry: z.number().int().positive().max(100) })])
  .optional();

const skillSchema = z.discriminatedUnion("kind", [
  z.object({ id: idField, kind: z.literal("slash"), command: z.string().min(1).max(128) }),
  z.object({ id: idField, kind: z.literal("prompt"), template: z.string().min(1).max(100_000) }),
]);

const gateAt = z.enum(["entry", "exit"]).optional();
const gateSchema = z.union([
  z.object({ id: idField, kind: z.literal("command"), run: z.string().min(1).max(2000), at: gateAt }),
  z.object({ id: idField, kind: z.literal("self"), prompt: z.string().max(2000).optional(), at: gateAt }),
  z.object({ id: idField, kind: z.literal("skill"), skill: idField, at: gateAt }),
  z.object({ id: idField, kind: z.literal("review"), role: z.string().max(64).optional(), at: gateAt }),
]);

const phaseSchema = z.object({
  id: idField,
  name: z.string().max(128).optional(),
  kind: z.string().max(64).optional(),
  skill: idField.optional(),
  role: z.string().max(64).optional(),
  provider: z.string().max(64).optional(),
  model: z.string().max(256).optional(),
  gate: idField.optional(),
  entryGate: idField.optional(),
  onFail: onFailSchema,
});

export const packManifestSchema = z.object({
  schema: z.literal("codeoid/pack@v1"),
  id: idField,
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
  description: z.string().max(2000).optional(),
  constitution: z.string().max(512).optional(), // path relative to the pack dir
  agents: z.string().max(512).optional(),
  roles: z.array(z.string().max(512)).max(32).default([]), // paths to role yaml files
  skills: z.array(skillSchema).max(64).default([]),
  gates: z.array(gateSchema).max(64).default([]),
  phases: z.array(phaseSchema).min(1).max(64),
});
export type PackManifest = z.infer<typeof packManifestSchema>;

/** A loaded pack: the runtime `Pack` plus the parsed metadata + capability roles
 *  (kept for the Cedar-compile / Shield-enforcement slice). */
export interface LoadedPack extends Pack {
  name: string;
  version: string;
  description?: string;
  /** Capability roles keyed by name (→ Cedar, enforced by Shield next). */
  roles: Record<string, RoleDef>;
  /** Constitution text composed into every phase prompt, if declared. */
  constitution?: string;
  dir: string;
}

export interface LoadPackOptions {
  /** Whether the host trusts this pack to execute `command` gates on its
   *  machine. Defaults to FALSE. A pack is pure data: it may *declare* a shell
   *  command, but declaring is not executing — a pack fetched from a shared /
   *  untrusted registry runs no host commands until an operator explicitly
   *  trusts it (Workspace-Trust / `direnv allow` model). Untrusted `command`
   *  gates fail closed, exactly like not-yet-enforced gates. */
  trusted?: boolean;
}

// ── Loader ────────────────────────────────────────────────────────────────

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resolve a pack-relative path, CONFINED to the pack directory. A manifest may
 *  only reference files it ships: absolute paths and `..` traversal are rejected,
 *  so a hostile pack can't read `/etc/shadow` or `../../secrets` into a prompt.
 *  (Boundary is `base + sep` so a sibling like `pack-evil` can't masquerade.) */
const underDir = (dir: string, rel: string): string => {
  const base = resolve(dir);
  const resolved = resolve(base, rel);
  if (isAbsolute(rel) || (resolved !== base && !resolved.startsWith(base + sep))) {
    throw new Error(`path "${rel}" escapes the pack directory`);
  }
  return resolved;
};
const readText = (path: string): string => readFileSync(path, "utf8");
const readYaml = (path: string): unknown => Bun.YAML.parse(readText(path));

/**
 * Parse + validate a pack directory into a runtime `Pack`. Throws with a precise
 * message on any manifest / role / reference error (fail fast at load). The
 * returned pack's `register()` installs its skills + gates into the registries;
 * its `pipeline` is the phase list (each phase carrying its capability `role`).
 * Phase gate ids may reference this pack's gates OR built-in gates (always /
 * manual) — those are validated at `create()` against the live registries.
 * `command` gates only execute when `opts.trusted` is set (default false).
 */
export function loadPack(dir: string, opts: LoadPackOptions = {}): LoadedPack {
  let manifestRaw: unknown;
  try {
    manifestRaw = readYaml(join(dir, "pack.yaml"));
  } catch (err) {
    throw new Error(`pack "${dir}": cannot read pack.yaml — ${errText(err)}`);
  }
  const parsed = packManifestSchema.safeParse(manifestRaw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new Error(`pack "${dir}": invalid pack.yaml — ${path}${first?.message ?? "schema error"}`);
  }
  const m = parsed.data;

  // Roles → parsed RoleDefs keyed by name.
  const roles: Record<string, RoleDef> = {};
  for (const rel of m.roles) {
    let roleRaw: unknown;
    try {
      roleRaw = readYaml(underDir(dir, rel));
    } catch (err) {
      throw new Error(`pack "${m.id}": cannot read role ${rel} — ${errText(err)}`);
    }
    const role = roleSchema.safeParse(roleRaw);
    if (!role.success) {
      throw new Error(`pack "${m.id}": invalid role ${rel} — ${role.error.issues[0]?.message ?? "schema error"}`);
    }
    roles[role.data.name] = role.data;
  }

  let constitution: string | undefined;
  if (m.constitution) {
    try {
      constitution = readText(underDir(dir, m.constitution));
    } catch (err) {
      throw new Error(`pack "${m.id}": cannot read constitution ${m.constitution} — ${errText(err)}`);
    }
  }

  const skills: SkillPlugin[] = m.skills.map((s) =>
    s.kind === "slash"
      ? { id: s.id, kind: "slash", command: s.command }
      : { id: s.id, kind: "prompt", template: s.template },
  );
  const skillIds = new Set(skills.map((s) => s.id));

  const gates: GatePlugin[] = m.gates.map((g) => buildGate(g, dir, opts.trusted ?? false));

  const seen = new Set<string>();
  const pipeline: PhaseDef[] = m.phases.map((p) => {
    if (seen.has(p.id)) throw new Error(`pack "${m.id}": duplicate phase id "${p.id}"`);
    seen.add(p.id);
    const kind = p.kind ?? (p.skill ? "skill" : undefined);
    if (!kind) throw new Error(`pack "${m.id}": phase "${p.id}" needs a kind or a skill`);
    if (p.skill && !skillIds.has(p.skill)) {
      throw new Error(`pack "${m.id}": phase "${p.id}" references unknown skill "${p.skill}"`);
    }
    if (p.role && !roles[p.role]) {
      throw new Error(`pack "${m.id}": phase "${p.id}" references unknown role "${p.role}"`);
    }
    const def: PhaseDef = { id: p.id, kind };
    if (p.name) def.name = p.name;
    if (p.skill) def.skill = p.skill;
    if (p.role) def.role = p.role;
    if (p.provider) def.provider = p.provider;
    if (p.model) def.model = p.model;
    if (p.gate) def.gate = p.gate;
    if (p.entryGate) def.entryGate = p.entryGate;
    const onFail = toOnFail(p.onFail);
    if (onFail) def.onFail = onFail;
    return def;
  });

  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    roles,
    constitution,
    dir,
    pipeline,
    register(r: PipelineRegistries): void {
      for (const s of skills) r.skills.register(s);
      for (const g of gates) r.gates.register(g);
    },
  };
}

function toOnFail(v: PackManifest["phases"][number]["onFail"]): PhaseFailAction | undefined {
  if (v === undefined) return undefined;
  if (v === "halt") return { action: "halt" };
  if (v === "abort") return { action: "abort" };
  return { action: "retry", max: v.retry };
}

// ── Gate builders ─────────────────────────────────────────────────────────

/** A gate that never passes — used for gates that must not silently succeed
 *  (untrusted command gates, and self/skill/review until the enforcement slice). */
function failClosedGate(id: string, at: "entry" | "exit", reason: string): GatePlugin {
  return { id, at, async evaluate() { return { pass: false, reason }; } };
}

function buildGate(g: PackManifest["gates"][number], dir: string, trusted: boolean): GatePlugin {
  const at = g.at ?? "exit";
  if (g.kind === "command") {
    // A command gate is DATA (a declared shell string). Executing it is a host
    // trust decision: an untrusted pack (the registry default) fails closed, so
    // fetching a pack never runs host commands until an operator opts in.
    if (!trusted) {
      return failClosedGate(g.id, at, `command gate "${g.id}" requires a trusted pack (host opt-in) — not executed`);
    }
    const run = g.run;
    return {
      id: g.id,
      at,
      async evaluate(ctx) {
        const cwd = ctx.pipeline.workdir ?? dir;
        const proc = Bun.spawn(["sh", "-c", run], { cwd, stdout: "ignore", stderr: "ignore" });
        const code = await proc.exited;
        return code === 0
          ? { pass: true }
          : { pass: false, reason: `command gate "${g.id}" failed (exit ${code}): ${run}` };
      },
    };
  }
  // self / skill / review gates are declared in the schema but not yet enforced
  // end-to-end. Fail CLOSED (never silently pass), so a pack using them halts for
  // a human until the gate-execution slice lands.
  return failClosedGate(g.id, at, `gate "${g.id}" (kind "${g.kind}") is not yet enforced`);
}
