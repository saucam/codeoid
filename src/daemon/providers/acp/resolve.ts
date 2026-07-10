/**
 * gemini-cli binary resolution — config override → system PATH → bundled
 * fallback (same posture as pi/resolve.ts: gemini-cli is pure JS, so the
 * pinned optionalDependency @google/gemini-cli runs under the daemon's own
 * runtime with zero user install; the lockfile freezes the exact CLI
 * version the ACP translation was tested against).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const BUNDLED_GEMINI_CLI_PACKAGE = "@google/gemini-cli";

export const GEMINI_CLI_INSTALL_HINT =
  `no gemini binary found — reinstall codeoid's dependencies (bundles ${BUNDLED_GEMINI_CLI_PACKAGE}), ` +
  `install it system-wide (npm i -g ${BUNDLED_GEMINI_CLI_PACKAGE}), or point providers.geminiCli.command at a binary`;

export interface GeminiCliResolution {
  command: string;
  argsPrefix: string[];
  source: "config" | "path" | "bundled";
}

export function resolveGeminiCliCommand(
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): GeminiCliResolution | null {
  if (configured !== undefined && configured !== "gemini") {
    if (configured.includes("/")) {
      return existsSync(configured)
        ? { command: configured, argsPrefix: [], source: "config" }
        : null;
    }
    const found = Bun.which(configured, { PATH: env.PATH ?? "" });
    return found ? { command: found, argsPrefix: [], source: "config" } : null;
  }

  const onPath = Bun.which("gemini", { PATH: env.PATH ?? "" });
  if (onPath) return { command: onPath, argsPrefix: [], source: "path" };

  const entry = bundledGeminiCliEntry();
  if (entry) return { command: process.execPath, argsPrefix: [entry], source: "bundled" };
  return null;
}

/**
 * Bundled CLI entry (`bundle/gemini.js` per the package's bin map). The
 * package has no main/exports, so locate it via its package.json.
 */
export function bundledGeminiCliEntry(): string | null {
  try {
    const pkgJson = Bun.resolveSync(`${BUNDLED_GEMINI_CLI_PACKAGE}/package.json`, import.meta.dir);
    const entry = join(dirname(pkgJson), "bundle", "gemini.js");
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}
