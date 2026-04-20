/**
 * Git worktree helper — spawns a fresh worktree in a sibling directory so that
 * a session can work on a branch without disturbing the main checkout.
 *
 * Convention: `<repo>.wt-<branch>` sits as a sibling of the repo root so the
 * main checkout path stays tidy. Example:
 *   repo  = /Workspace/codeoid
 *   branch = feat/new-parser
 *   worktree → /Workspace/codeoid.wt-feat-new-parser
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface CreateWorktreeOptions {
  /** Branch name to check out in the worktree. Created if it doesn't exist. */
  branch: string;
  /** Source repo path (must be a git checkout). */
  repo: string;
  /** Optional override for the worktree directory path. */
  workdir?: string;
}

/** Create the worktree (idempotent — re-uses an existing worktree at the same path). */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const repoAbs = isAbsolute(opts.repo) ? opts.repo : resolve(process.cwd(), opts.repo);

  if (!existsSync(join(repoAbs, ".git"))) {
    throw new Error(
      `${repoAbs} does not look like a git repo (no .git). Pass --repo to point at one.`,
    );
  }

  const safeBranch = opts.branch.replace(/[\/\\]/g, "-");
  const target = opts.workdir
    ? isAbsolute(opts.workdir)
      ? opts.workdir
      : resolve(process.cwd(), opts.workdir)
    : join(dirname(repoAbs), `${basename(repoAbs)}.wt-${safeBranch}`);

  // Existing worktree at target path — treat as idempotent reuse.
  if (existsSync(target)) {
    return target;
  }

  // Does the branch already exist locally?
  let branchExists = false;
  try {
    execSync(`git rev-parse --verify --quiet ${shellEscape(opts.branch)}`, {
      cwd: repoAbs,
      stdio: "ignore",
    });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  const cmd = branchExists
    ? `git worktree add ${shellEscape(target)} ${shellEscape(opts.branch)}`
    : `git worktree add -b ${shellEscape(opts.branch)} ${shellEscape(target)}`;

  execSync(cmd, { cwd: repoAbs, stdio: "inherit" });
  return target;
}

function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_\-.\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
