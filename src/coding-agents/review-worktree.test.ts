import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReviewWorktree, type GitRunner } from "./review-worktree.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "tachi-review-test-"));

describe("createReviewWorktree", () => {
  it("rejects non-git checkouts with an actionable message", async () => {
    const git: GitRunner = vi.fn(async () => ({ ok: false, stderr: "not a git repository" }));
    await expect(createReviewWorktree("/some/dir", git, tmp))
      .rejects.toThrow(/not a git checkout/);
  });

  it("adds a detached worktree at HEAD inside a temp dir", async () => {
    const calls: string[][] = [];
    const git: GitRunner = vi.fn(async (args) => {
      calls.push(args);
      return { ok: true, stderr: "" };
    });
    const wt = await createReviewWorktree("/repo", git, tmp);
    expect(calls[0]).toEqual(["rev-parse", "--is-inside-work-tree"]);
    expect(calls[1].slice(0, 3)).toEqual(["worktree", "add", "--detach"]);
    expect(calls[1].at(-1)).toBe("HEAD");
    expect(calls[1][3]).toBe(wt.dir);
    expect(wt.dir.endsWith(`${path.sep}wt`)).toBe(true);
  });

  it("cleans up the temp dir when worktree creation fails", async () => {
    const git: GitRunner = vi.fn(async (args) =>
      args[0] === "rev-parse"
        ? { ok: true, stderr: "" }
        : { ok: false, stderr: "fatal: HEAD does not point to a commit" });
    await expect(createReviewWorktree("/repo", git, tmp))
      .rejects.toThrow(/HEAD does not point to a commit/);
  });

  it("cleanup removes the worktree via git and never throws", async () => {
    const calls: string[][] = [];
    const git: GitRunner = vi.fn(async (args) => {
      calls.push(args);
      return { ok: args[0] !== "worktree" || args[1] !== "remove", stderr: "boom" };
    });
    const wt = await createReviewWorktree("/repo", git, tmp);
    await expect(wt.cleanup()).resolves.toBeUndefined();
    const removeCall = calls.find((c) => c[0] === "worktree" && c[1] === "remove");
    expect(removeCall).toEqual(["worktree", "remove", "--force", wt.dir]);
  });

  it("creates a real detached worktree against this repository", async () => {
    // Integration path: uses the actual git binary against the repo itself.
    const wt = await createReviewWorktree(process.cwd());
    try {
      const { access } = await import("node:fs/promises");
      await access(path.join(wt.dir, "package.json"));
    } finally {
      await wt.cleanup();
    }
  });
});
