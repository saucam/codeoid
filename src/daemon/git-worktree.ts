/**
 * Git worktree isolation for `session.fork`.
 *
 * A fork must not share the parent's working directory — two agents editing
 * the same files collide. When the parent's workdir is a git repo, a fork gets
 * its OWN git worktree on its OWN branch, seeded with the parent's CURRENT
 * working state (uncommitted tracked changes included), while the parent's
 * checkout is left byte-for-byte untouched.
 *
 * The "carry current state without disturbing the parent" trick:
 *
 *   1. `git stash create` in the parent → a commit object of the dirty tracked
 *      state (empty when clean). It mutates nothing: no index, no working tree,
 *      no stash list — the parent session keeps working uninterrupted.
 *   2. `git worktree add -b <branch> <dir> <snapshot|HEAD>` → a fresh worktree
 *      + branch at that state.
 *   3. If we based on a snapshot, `git reset --mixed <parent-HEAD>` in the new
 *      worktree moves the branch tip back to HEAD and re-materializes the
 *      carried changes as UNCOMMITTED edits — so the fork opens exactly where
 *      the parent was.
 *
 * Untracked/ignored files are NOT carried (git stash create only snapshots
 * tracked content) — a documented follow-up. Everything here runs the local
 * `git` binary via execFile (the daemon is co-located with the repo); there is
 * no remote-host tunnel.
 *
 * Ownership: only worktrees codeoid CREATED are ever removed (see
 * SessionInfo.worktree.createdByCodeoid). A worktree the user pointed a fork
 * at (bind mode) is theirs and is never touched.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run git in `cwd`. Generous buffer for large `worktree list` output. */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** True when `workdir` is inside a git working tree. */
export async function isGitRepo(workdir: string): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], workdir)).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Validate a branch name against the subset of `git check-ref-format` rules
 * that matter for a single branch ref. Throws {@link WorktreeError} on a bad
 * name so a caller-supplied branch can't inject git args or a broken ref.
 */
export class WorktreeError extends Error {}

export function validateBranchName(name: string): void {
  const bad =
    !name ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@" ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
  if (bad) throw new WorktreeError(`invalid branch name: ${JSON.stringify(name)}`);
}

/** Ref-safe, single-segment slug from an arbitrary label. */
function slug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return s.length > 0 ? s : "session";
}

/**
 * Absolute path of the repo's MAIN working tree. `git worktree list
 * --porcelain`'s first record is always the main checkout, regardless of which
 * linked worktree we ask from — so new worktrees anchor beside the main repo
 * (`<repo>-worktrees/<name>`), never nested inside another worktree.
 */
async function mainWorktreeRoot(workdir: string): Promise<string> {
  const out = await git(["worktree", "list", "--porcelain"], workdir);
  const line = out.split("\n").find((l) => l.startsWith("worktree "));
  if (!line) throw new WorktreeError("could not resolve the repo's main worktree");
  return line.slice("worktree ".length).trim();
}

export interface ForkWorktree {
  /** Absolute path of the created worktree ROOT — used for git ops (removal). */
  path: string;
  /**
   * The fork's ACTIVE working directory: the worktree root joined with the
   * parent's subdirectory within its own checkout. When the parent session
   * worked in a repo subdir (e.g. `packages/api`), the fork opens in the
   * equivalent subdir of the new worktree, not its root — so relative paths,
   * tooling, and scripts keep working. Equals `path` when the parent was at
   * the checkout root.
   */
  workdir: string;
  /** Branch checked out in the worktree (e.g. "codeoid/fix-login-a1b2c3"). */
  branch: string;
}

/**
 * Create an isolated worktree for a fork, carrying the parent's current tracked
 * working state. `workdir` is the PARENT's workdir (any worktree of the repo).
 * The parent is left untouched. Throws {@link WorktreeError} on any git failure
 * so the caller can fall back to a shared workdir.
 */
export async function createForkWorktree(opts: {
  workdir: string;
  /** Human label (session name) → branch/dir slug. */
  label: string;
  /** Short unique suffix (e.g. first 8 of the fork's id). */
  shortId: string;
}): Promise<ForkWorktree> {
  const mainRoot = await mainWorktreeRoot(opts.workdir);

  // Parent HEAD must exist (a repo with no commits can't be worktree'd).
  let parentHead: string;
  try {
    parentHead = (await git(["rev-parse", "HEAD"], opts.workdir)).trim();
  } catch {
    throw new WorktreeError("repository has no commits yet (unborn HEAD)");
  }

  const name = `${slug(opts.label)}-${opts.shortId}`;
  const branch = `codeoid/${name}`;
  validateBranchName(branch);
  const worktreePath = path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-worktrees`, name);

  // Snapshot the parent's dirty tracked state WITHOUT touching it. Empty when
  // the tree is clean → base the worktree on HEAD directly.
  const snapshot = (await git(["stash", "create"], opts.workdir)).trim();
  const base = snapshot || parentHead;

  try {
    await git(["worktree", "add", "-b", branch, worktreePath, base], mainRoot);
  } catch (err) {
    throw new WorktreeError(
      `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Re-materialize the carried changes as uncommitted edits on top of HEAD.
  if (snapshot) {
    try {
      await git(["reset", "--mixed", parentHead], worktreePath);
    } catch (err) {
      // The worktree exists but the reset failed — roll it back so we don't
      // leave a fork sitting on a snapshot commit.
      await removeForkWorktree({ workdir: mainRoot, worktreePath, branch, deleteBranch: true }).catch(
        () => {},
      );
      throw new WorktreeError(
        `git reset after worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Preserve the parent's subdirectory within its checkout: if the session was
  // working in `<repo>/packages/api`, the fork should open in
  // `<worktree>/packages/api`, not the worktree root. Relative to the PARENT's
  // OWN worktree top (handles a parent that is itself a linked worktree).
  let workdir = worktreePath;
  try {
    const parentTop = (await git(["rev-parse", "--show-toplevel"], opts.workdir)).trim();
    const rel = path.relative(parentTop, opts.workdir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      workdir = path.join(worktreePath, rel);
    }
  } catch {
    // Fall back to the worktree root — never fail the fork over a subdir hint.
  }

  return { path: worktreePath, workdir, branch };
}

/**
 * Remove a worktree codeoid created. Best-effort and idempotent: never throws.
 * `deleteBranch` defaults to FALSE — keeping the branch means a fork's work is
 * recoverable even after its session is destroyed.
 */
export async function removeForkWorktree(opts: {
  /** Any workdir of the repo (used to locate the main worktree for git). */
  workdir: string;
  worktreePath: string;
  branch?: string;
  deleteBranch?: boolean;
}): Promise<void> {
  const mainRoot = await mainWorktreeRoot(opts.workdir).catch(() => opts.workdir);

  // Preserve uncommitted work on the KEPT branch before the forced removal —
  // otherwise `worktree remove --force` silently discards it, and "the branch
  // is kept so work survives" would only be true for already-committed work.
  // Skipped when we're deleting the branch anyway (orphan cleanup). Best-effort
  // and hermetic: a pinned identity means it works with no user git config;
  // `add -A` also sweeps in untracked files. On any failure we just proceed to
  // remove (no worse than before).
  if (!opts.deleteBranch) {
    try {
      const dirty = (await git(["status", "--porcelain"], opts.worktreePath)).trim();
      if (dirty) {
        await git(["add", "-A"], opts.worktreePath);
        await git(
          [
            "-c",
            "user.email=codeoid@localhost",
            "-c",
            "user.name=codeoid",
            "commit",
            "--no-verify",
            "-m",
            "codeoid: WIP snapshot saved on session destroy",
          ],
          opts.worktreePath,
        );
      }
    } catch {
      // No commit identity / hook refusal / already-clean race — fall through.
    }
  }

  await git(["worktree", "remove", "--force", opts.worktreePath], mainRoot).catch(() => {});
  // Prune any dangling administrative entry even if the dir was already gone.
  await git(["worktree", "prune"], mainRoot).catch(() => {});
  if (opts.deleteBranch && opts.branch) {
    await git(["branch", "-D", opts.branch], mainRoot).catch(() => {});
  }
}

/** Current branch of a workdir (for bind mode), or null when detached/non-repo. */
export async function currentBranch(workdir: string): Promise<string | null> {
  try {
    const b = (await git(["rev-parse", "--abbrev-ref", "HEAD"], workdir)).trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}
