/**
 * git-worktree — the fork isolation primitive. Runs the real `git` binary
 * against throwaway repos, so it proves the stash-create → worktree → reset
 * dance actually carries the parent's dirty state AND leaves the parent
 * untouched (the whole safety contract).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createForkWorktree,
  currentBranch,
  isGitRepo,
  removeForkWorktree,
  validateBranchName,
  WorktreeError,
} from "../daemon/git-worktree.js";

const execFileP = promisify(execFile);
const g = (args: string[], cwd: string) => execFileP("git", args, { cwd }).then((r) => r.stdout.trim());

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-wt-"));
  repo = join(tmp, "repo");
  await execFileP("git", ["init", "-b", "main", repo]);
  await g(["config", "user.email", "t@t.dev"], repo);
  await g(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "file.txt"), "committed\n");
  await g(["add", "."], repo);
  await g(["commit", "-m", "init"], repo);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isGitRepo", () => {
  it("distinguishes a repo from a plain dir", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(tmp)).toBe(false);
  });
});

describe("validateBranchName", () => {
  it("accepts good names, rejects dangerous ones", () => {
    expect(() => validateBranchName("codeoid/fix-login-a1b2c3")).not.toThrow();
    for (const bad of ["-x", "/x", "x/", "x.", "a..b", "a b", "x.lock", "@", "a~b", "a^b", "a:b", "a\\b"]) {
      expect(() => validateBranchName(bad), bad).toThrow(WorktreeError);
    }
  });
});

describe("createForkWorktree", () => {
  it("carries the parent's UNCOMMITTED tracked edit into an isolated worktree, parent untouched", async () => {
    // Parent has a dirty tracked edit.
    writeFileSync(join(repo, "file.txt"), "committed\nWIP edit\n");
    const parentHeadBefore = await g(["rev-parse", "HEAD"], repo);
    const parentStatusBefore = await g(["status", "--porcelain"], repo);
    const stashListBefore = await g(["stash", "list"], repo);

    const wt = await createForkWorktree({ workdir: repo, label: "Fix Login", shortId: "a1b2c3d4" });

    // The fork worktree exists, on its own codeoid branch.
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.branch).toBe("codeoid/fix-login-a1b2c3d4");
    expect(await currentBranch(wt.path)).toBe("codeoid/fix-login-a1b2c3d4");

    // The carried edit is present in the fork...
    expect(readFileSync(join(wt.path, "file.txt"), "utf8")).toBe("committed\nWIP edit\n");
    // ...and shows as an UNCOMMITTED change (branch tip == parent HEAD, tree dirty).
    expect(await g(["rev-parse", "HEAD"], wt.path)).toBe(parentHeadBefore);
    expect(await g(["status", "--porcelain"], wt.path)).toContain("file.txt");

    // The PARENT is byte-for-byte untouched: same HEAD, same dirty status, no
    // new stash entries, still on its original branch.
    expect(await g(["rev-parse", "HEAD"], repo)).toBe(parentHeadBefore);
    expect(await g(["status", "--porcelain"], repo)).toBe(parentStatusBefore);
    expect(await g(["stash", "list"], repo)).toBe(stashListBefore);
    expect(await currentBranch(repo)).toBe("main");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("committed\nWIP edit\n");
  });

  it("a clean parent yields a clean worktree at HEAD", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "clean", shortId: "deadbeef" });
    expect(await g(["status", "--porcelain"], wt.path)).toBe("");
    expect(await g(["rev-parse", "HEAD"], wt.path)).toBe(await g(["rev-parse", "HEAD"], repo));
  });

  it("edits in the fork do NOT collide with the parent (separate working trees)", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "branch", shortId: "cafebabe" });
    writeFileSync(join(wt.path, "file.txt"), "fork-only change\n");
    writeFileSync(join(repo, "file.txt"), "parent-only change\n");
    // Neither stomped the other — physically separate directories.
    expect(readFileSync(join(wt.path, "file.txt"), "utf8")).toBe("fork-only change\n");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("parent-only change\n");
  });

  it("preserves the parent's subdirectory in the fork's workdir (path stays the root)", async () => {
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "packages", "api", "x.txt"), "a\n");
    await g(["add", "."], repo);
    await g(["commit", "-m", "subdir"], repo);
    writeFileSync(join(repo, "packages", "api", "x.txt"), "a\nWIP\n"); // dirty edit in the subdir

    const wt = await createForkWorktree({
      workdir: join(repo, "packages", "api"),
      label: "sub",
      shortId: "55556666",
    });

    // path = worktree ROOT (for git ops); workdir = root + the parent's subdir.
    expect(wt.workdir).toBe(join(wt.path, "packages", "api"));
    expect(existsSync(wt.workdir)).toBe(true);
    // The carried edit is present at the subdir path.
    expect(readFileSync(join(wt.workdir, "x.txt"), "utf8")).toBe("a\nWIP\n");
  });

  it("workdir equals path when the parent is at the checkout root", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "root", shortId: "77778888" });
    expect(wt.workdir).toBe(wt.path);
  });

  it("rejects an unborn repo (no commits)", async () => {
    const empty = join(tmp, "empty");
    await execFileP("git", ["init", "-b", "main", empty]);
    expect(createForkWorktree({ workdir: empty, label: "x", shortId: "00000000" })).rejects.toThrow(
      WorktreeError,
    );
  });
});

describe("removeForkWorktree", () => {
  it("removes the worktree dir but keeps the branch by default (work is recoverable)", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "keep", shortId: "11112222" });
    await removeForkWorktree({ workdir: repo, worktreePath: wt.path, branch: wt.branch });
    expect(existsSync(wt.path)).toBe(false);
    // Branch still exists.
    const branches = await g(["branch", "--list", wt.branch], repo);
    expect(branches).toContain(wt.branch);
  });

  it("deleteBranch:true also removes the branch", async () => {
    const wt = await createForkWorktree({ workdir: repo, label: "drop", shortId: "33334444" });
    await removeForkWorktree({ workdir: repo, worktreePath: wt.path, branch: wt.branch, deleteBranch: true });
    expect(await g(["branch", "--list", wt.branch], repo)).toBe("");
  });

  it("is a no-op (never throws) on an already-gone worktree", async () => {
    await removeForkWorktree({ workdir: repo, worktreePath: join(tmp, "nope"), branch: "codeoid/none" });
  });
});
