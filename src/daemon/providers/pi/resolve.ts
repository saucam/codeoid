/**
 * pi binary resolution — config override → system PATH → bundled fallback.
 *
 * pi ships with codeoid as a pinned optionalDependency
 * (@earendil-works/pi-coding-agent), so the backend works out of the box
 * with zero user action. The pin matters beyond convenience: the injected
 * bridge extension (bridge.ts) is coupled to pi's RPC + extension API, and
 * the fail-closed approval gate is only as trustworthy as the pi version
 * it was tested against — the lockfile freezes exactly that version. A
 * system install or an explicit `providers.pi.command` still wins for
 * users who want their own build.
 *
 * Resolution is verified up front (existsSync / PATH lookup) so a missing
 * binary is a "not installed" entry in the provider catalog with an
 * actionable hint, instead of a spawn failure on the user's first turn.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const BUNDLED_PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** Shown when no pi can be found anywhere (bundled install failed AND no
 *  system pi) or a configured command doesn't exist. */
export const PI_INSTALL_HINT =
  `no pi binary found — reinstall codeoid's dependencies (bundles ${BUNDLED_PI_PACKAGE}), ` +
  `install pi system-wide (npm i -g ${BUNDLED_PI_PACKAGE}), or point providers.pi.command at a binary`;

export interface PiCommandResolution {
  /** Executable to spawn — an absolute path, or the runtime for `bundled`. */
  command: string;
  /** argv entries that must PRECEDE pi's own flags (bundled: the cli entry). */
  argsPrefix: string[];
  source: "config" | "path" | "bundled";
}

/**
 * Resolve the pi command. `configured` is `providers.pi.command` when the
 * user set it to something other than the default "pi". Returns null when
 * nothing runnable was found — callers surface PI_INSTALL_HINT.
 */
export function resolvePiCommand(
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): PiCommandResolution | null {
  // 1. Explicit config override. Verified rather than trusted blindly so a
  //    typo'd path shows up at startup, not on the first turn.
  if (configured !== undefined && configured !== "pi") {
    if (configured.includes("/")) {
      return existsSync(configured)
        ? { command: configured, argsPrefix: [], source: "config" }
        : null;
    }
    const found = Bun.which(configured, { PATH: env.PATH ?? "" });
    return found ? { command: found, argsPrefix: [], source: "config" } : null;
  }

  // 2. System pi on PATH.
  const onPath = Bun.which("pi", { PATH: env.PATH ?? "" });
  if (onPath) return { command: onPath, argsPrefix: [], source: "path" };

  // 3. Bundled optionalDependency, run via the daemon's own runtime (bun)
  //    so the fallback doesn't additionally require node on PATH.
  const entry = bundledPiEntry();
  if (entry) return { command: process.execPath, argsPrefix: [entry], source: "bundled" };

  return null;
}

/**
 * Absolute path to the bundled pi CLI entry (`dist/cli.js`), or null when
 * the optional dependency isn't installed. The package's exports map has
 * no "./package.json" subpath, so locate the main entry and derive the
 * sibling cli entry from it (both live in dist/ — bin: {"pi": "dist/cli.js"}).
 */
export function bundledPiEntry(): string | null {
  try {
    const mainEntry = Bun.resolveSync(BUNDLED_PI_PACKAGE, import.meta.dir);
    const cli = join(dirname(mainEntry), "cli.js");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}
