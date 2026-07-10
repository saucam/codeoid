/**
 * codex binary resolution — config override → system PATH → common Node
 * install dirs.
 *
 * No BUNDLED fallback (yet): @openai/codex ships a per-platform native Rust
 * binary, so bundling needs a size/platform audit first — see
 * docs/provider-codex-design.md. But codex is almost always installed via a
 * Node package manager, and the daemon frequently runs with a PATH that
 * omits the user's nvm / npm-global bin (a launchd/systemd service, or a
 * shell that never sourced nvm). So after PATH we scan the standard
 * per-user Node bin locations before giving up — otherwise a codex that is
 * clearly installed shows as "not installed". A missing binary still lands
 * on the registry's supported-but-unavailable hint (#141).
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_INSTALL_HINT =
  "no codex binary found — install the Codex CLI (npm i -g @openai/codex) " +
  "or point providers.codex.command at a binary";

export interface CodexCommandResolution {
  command: string;
  argsPrefix: string[];
  source: "config" | "path" | "node-bin";
}

export function resolveCodexCommand(
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): CodexCommandResolution | null {
  // 1. Explicit config override — verified so a typo is loud at startup,
  //    not a first-turn spawn failure.
  if (configured !== undefined && configured !== "codex") {
    if (configured.includes("/")) {
      return existsSync(configured)
        ? { command: configured, argsPrefix: [], source: "config" }
        : null;
    }
    const found = Bun.which(configured, { PATH: env.PATH ?? "" });
    return found ? { command: found, argsPrefix: [], source: "config" } : null;
  }

  // 2. System codex on PATH.
  const onPath = Bun.which("codex", { PATH: env.PATH ?? "" });
  if (onPath) return { command: onPath, argsPrefix: [], source: "path" };

  // 3. Common per-user Node bin dirs the daemon's PATH may not include.
  for (const dir of nodeBinDirs(env)) {
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) {
      return { command: candidate, argsPrefix: [], source: "node-bin" };
    }
  }
  return null;
}

/**
 * Candidate per-user Node bin directories, newest-nvm-first. Covers nvm
 * (every installed node version), the active nvm/Volta/fnm bin, an
 * npm-global prefix, and ~/.local/bin. Best-effort — unreadable dirs are
 * skipped.
 */
function nodeBinDirs(env: Record<string, string | undefined>): string[] {
  const home = env.HOME ?? homedir();
  const dirs: string[] = [];

  // nvm: ~/.nvm/versions/node/<version>/bin — prefer the highest version.
  const nvmVersions = join(home, ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvmVersions)
      .filter((v) => v.startsWith("v"))
      .sort(compareNodeVersionsDesc);
    for (const v of versions) dirs.push(join(nvmVersions, v, "bin"));
  } catch {
    /* no nvm */
  }

  // Active version managers + npm global + user-local.
  if (env.NVM_BIN) dirs.push(env.NVM_BIN);
  if (env.VOLTA_HOME) dirs.push(join(env.VOLTA_HOME, "bin"));
  if (env.npm_config_prefix) dirs.push(join(env.npm_config_prefix, "bin"));
  dirs.push(join(home, ".npm-global", "bin"));
  dirs.push(join(home, ".local", "bin"));
  dirs.push("/usr/local/bin");

  // De-dup while preserving order.
  return [...new Set(dirs)];
}

/** Sort "v21.5.0" > "v20.11.1" numerically, descending. */
function compareNodeVersionsDesc(a: string, b: string): number {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
