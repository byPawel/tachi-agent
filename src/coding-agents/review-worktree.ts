// src/coding-agents/review-worktree.ts
/**
 * Throwaway git worktree for review-mode workers whose "read-only" promise is
 * soft. Gemini's headless --approval-mode plan auto-flips to YOLO after
 * plan-exit, so the worker runs against a detached HEAD copy: the requested
 * checkout can never be mutated, and the tamper guard (gemini-parse.ts)
 * reports any writes that hit the disposable copy. Tradeoff (documented in
 * README): the reviewer sees HEAD, not uncommitted changes.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ReviewWorktree {
  dir: string;
  cleanup(): Promise<void>;
}

export type GitRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; stderr: string }>;

const defaultGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd }, (err, _stdout, stderr) =>
      resolve({ ok: !err, stderr: String(stderr ?? "") }));
  });

const defaultMakeTmp = (): Promise<string> => mkdtemp(path.join(tmpdir(), "tachi-review-"));

/** Create a detached-HEAD worktree in a temp dir. Fails on non-git checkouts. */
export async function createReviewWorktree(
  repoCwd: string,
  git: GitRunner = defaultGit,
  makeTmp: () => Promise<string> = defaultMakeTmp,
): Promise<ReviewWorktree> {
  const probe = await git(["rev-parse", "--is-inside-work-tree"], repoCwd);
  if (!probe.ok) {
    throw new Error(
      `gemini review mode isolates the worker in a git worktree, but ${repoCwd} is not a git checkout. ` +
      "Run it from a git repository, or use another agent (codex/grok/claude) whose review sandbox is native.",
    );
  }
  const base = await makeTmp();
  const dir = path.join(base, "wt");
  const added = await git(["worktree", "add", "--detach", dir, "HEAD"], repoCwd);
  if (!added.ok) {
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`failed to create review worktree: ${added.stderr.trim() || "git worktree add failed"}`);
  }
  return {
    dir,
    // Best-effort teardown: a failed remove must never mask the run's result.
    cleanup: async () => {
      await git(["worktree", "remove", "--force", dir], repoCwd);
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
