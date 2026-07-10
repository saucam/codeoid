/**
 * codex binary resolution — config override → system PATH.
 *
 * No bundled fallback (yet): @openai/codex ships a per-platform native
 * Rust binary, so bundling needs a size/platform audit first — see
 * docs/provider-codex-design.md. Until then, the registry's
 * supported-but-unavailable path (#141) surfaces the install hint in the
 * catalog, the startup log, and session.set_provider errors.
 */

import { existsSync } from "node:fs";

export const CODEX_INSTALL_HINT =
  "no codex binary found — install the Codex CLI (npm i -g @openai/codex) " +
  "or point providers.codex.command at a binary";

export interface CodexCommandResolution {
  command: string;
  argsPrefix: string[];
  source: "config" | "path";
}

export function resolveCodexCommand(
  configured: string | undefined,
  env: Record<string, string | undefined> = process.env,
): CodexCommandResolution | null {
  // Explicit config override — verified so a typo is loud at startup, not
  // a first-turn spawn failure.
  if (configured !== undefined && configured !== "codex") {
    if (configured.includes("/")) {
      return existsSync(configured)
        ? { command: configured, argsPrefix: [], source: "config" }
        : null;
    }
    const found = Bun.which(configured, { PATH: env.PATH ?? "" });
    return found ? { command: found, argsPrefix: [], source: "config" } : null;
  }
  const onPath = Bun.which("codex", { PATH: env.PATH ?? "" });
  return onPath ? { command: onPath, argsPrefix: [], source: "path" } : null;
}
