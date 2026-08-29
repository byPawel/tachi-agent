#!/usr/bin/env node
// scripts/eval-openrouter-harness.mjs
/**
 * Reproducible live A/B of the two private harnesses that can sit behind
 * tachi-agent's public `run_coding_agent({ agent: "openrouter" })` contract:
 * the Hermes Agent CLI (`hermes`) and the Codex CLI (`codex`).
 *
 * The harness is selected by TACHI_OPENROUTER_HARNESS, which the adapter reads
 * from process.env at spawn time — this script therefore only sets the variable
 * and calls the BUILT runner; it never imports the adapter directly, so the
 * measured path is exactly the one an MCP caller gets.
 *
 * THIS SCRIPT SPENDS MONEY. Every run makes real OpenRouter calls with the
 * configured model. It refuses to start (exit 2) unless every prerequisite is
 * present, and it creates nothing before that check passes.
 *
 * Output is NDJSON on stdout — one line per harness/phase, then one summary
 * line. Human-readable progress goes to stderr, so stdout stays machine
 * readable. Model answers are never printed (lengths only) and the API key is
 * redacted from every string that reaches stdout.
 *
 * Exit codes:
 *   0  evaluation completed (a harness failing its task is data, not an error)
 *   1  integrity violation — a review run mutated its checkout
 *   2  missing prerequisites (nothing was created, nothing was billed)
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(HERE, "fixtures", "openrouter-harness");
const DIST_RUNNER = path.join(REPO_ROOT, "dist", "coding-agents", "runner.js");
/**
 * Offline dry-run seam. Point TACHI_EVAL_RUNNER at a stub module exporting
 * `runCodingAgent` to exercise the checkout/diff/rubric plumbing without
 * billing anything; every result line and the summary are stamped with the
 * override so a dry run can never be mistaken for a real measurement.
 */
const RUNNER_OVERRIDE = process.env.TACHI_EVAL_RUNNER?.trim();
const RUNNER_PATH = RUNNER_OVERRIDE ? path.resolve(RUNNER_OVERRIDE) : DIST_RUNNER;

/** Order matters: the incumbent runs first so a shared outage is obvious. */
const HARNESSES = ["hermes", "codex"];

/**
 * The only paths a correct write run may touch. The test file is allowed —
 * a harness that reads or adjusts the test while fixing the bug is not
 * littering — but `src/sum.js` must be among them: a run that changed nothing,
 * or only the test, did not fix the planted bug.
 */
const EXPECTED_WRITE_PATHS = ["src/sum.js", "test/sum.test.js"];
const REQUIRED_WRITE_PATH = "src/sum.js";

const WRITE_TASK = "Fix the bug in src/sum.js so all tests pass. Run the tests to confirm.";
const REVIEW_TASK =
  "Review src/sum.js against the tests in test/ and explain in prose why the tests fail. "
  + "Do not modify, create, or delete any files.";

const MAX_TURNS = 20;
const TIMEOUT_MS = 600_000;
/** Error text is truncated hard: it can echo worker stdout, which is answer text. */
const MAX_ERROR_CHARS = 500;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Shell-free child process runner. Never rejects; the caller inspects `code`. */
function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/** Resolve a command on the same PATH a spawned worker would use, shell-free. */
async function hasBinary(command) {
  if (process.platform === "win32") return (await exec("where", [command])).code === 0;
  // `command -v` is a shell builtin, so sh is invoked — but the candidate is
  // passed as positional $1, never interpolated: no injection surface.
  return (await exec("/bin/sh", ["-c", 'command -v -- "$1" >/dev/null 2>&1', "sh", command])).code === 0;
}

/** Strip the API key from anything that could reach stdout. */
function redact(text) {
  const key = process.env.OPENROUTER_API_KEY;
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return key ? flat.split(key).join("«redacted»") : flat;
}

function conciseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const clean = redact(message);
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function note(message) {
  process.stderr.write(`[eval] ${message}\n`);
}

// ---------------------------------------------------------------------------
// prerequisites — checked FIRST, before anything is created or billed
// ---------------------------------------------------------------------------

function harnessCliEnvVar(harness) {
  // The adapter reuses HERMES_CLI for the hermes harness (see runner.envCommand).
  return harness === "hermes" ? "HERMES_CLI" : "CODEX_CLI";
}

function harnessCommand(harness) {
  return process.env[harnessCliEnvVar(harness)]?.trim() || harness;
}

async function missingPrerequisites() {
  const missing = [];

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    missing.push("OPENROUTER_API_KEY (no OpenRouter credential)");
  }
  if (!(process.env.TACHI_OPENROUTER_CODING_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim())) {
    missing.push("TACHI_OPENROUTER_CODING_MODEL or OPENROUTER_MODEL (no model selected)");
  }
  for (const harness of HARNESSES) {
    const command = harnessCommand(harness);
    if (!(await hasBinary(command))) {
      missing.push(`${harness} CLI "${command}" not found on PATH (set ${harnessCliEnvVar(harness)})`);
    }
  }
  if (!(await fileReadable(RUNNER_PATH))) {
    missing.push(RUNNER_OVERRIDE
      ? `TACHI_EVAL_RUNNER module ${RUNNER_PATH} (not readable)`
      : `built runner ${path.relative(REPO_ROOT, RUNNER_PATH)} (run \`npm run build\`)`);
  }
  if (process.env.TACHI_CODING_DEPTH) {
    // The runner's recursion guard would reject every call; say so up front
    // instead of billing nothing and reporting six mysterious failures.
    missing.push("a clean environment — TACHI_CODING_DEPTH is set, so this shell is a tachi-spawned worker");
  }
  return missing;
}

async function fileReadable(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// fixture checkouts
// ---------------------------------------------------------------------------

/**
 * Fresh throwaway git checkout of the fixture. Ownership transfers to the caller
 * only on success: every failure path in here removes the directory before
 * rethrowing, so a throw after `mkdtemp` cannot leak a temp dir the caller's
 * `finally` never learned about.
 */
async function createCheckout(label) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tachi-eval-${label}-`));
  try {
    const resolved = await realpath(dir);
    await cp(FIXTURE_DIR, resolved, { recursive: true });
    // A hermes `--worktree` run needs a real repo with at least one commit; the
    // diff/manifest checks need a baseline too. Identity and signing are pinned
    // per-command so a developer's global git config cannot block the commit.
    const git = (args) => exec("git", ["-c", "user.name=tachi-eval", "-c", "user.email=eval@tachi.local", "-c", "commit.gpgsign=false", ...args], { cwd: resolved });
    await git(["init", "-q"]);
    await git(["add", "-A"]);
    const commit = await git(["commit", "-q", "-m", "baseline: failing sum fixture", "--no-gpg-sign"]);
    if (commit.code !== 0) {
      throw new Error(`fixture baseline commit failed: ${redact(commit.stderr || commit.stdout)}`);
    }
    return resolved;
  } catch (error) {
    await disposeCheckout(dir);
    throw error;
  }
}

async function disposeCheckout(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** sha256 manifest of the working tree (excluding .git) — catches adds and deletes. */
async function hashTree(dir) {
  const manifest = {};
  const walk = async (relative) => {
    const absolute = path.join(dir, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      // .git churns on any git command, and an isolated worktree legitimately
      // registers itself under .git/worktrees — neither is checkout tampering.
      if (entry.name === ".git") continue;
      const childRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(childRelative);
      } else if (entry.isFile()) {
        manifest[childRelative] = createHash("sha256").update(await readFile(path.join(absolute, entry.name))).digest("hex");
      } else {
        manifest[childRelative] = `non-regular:${entry.isSymbolicLink() ? "symlink" : "other"}`;
      }
    }
  };
  await walk("");
  return manifest;
}

function manifestDelta(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((p) => before[p] !== after[p]).sort();
}

/** Tracked modifications plus untracked additions — harness litter counts. */
async function changedPaths(dir) {
  const tracked = await exec("git", ["--no-pager", "diff", "--name-only", "HEAD"], { cwd: dir });
  const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: dir });
  const split = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    changed: split(tracked.stdout).sort(),
    untracked: split(untracked.stdout).sort(),
  };
}

async function runFixtureTests(dir) {
  const result = await exec(process.execPath, ["--test"], { cwd: dir, timeoutMs: 120_000 });
  return { passed: result.code === 0, exitCode: result.code };
}

// ---------------------------------------------------------------------------
// harness invocation
// ---------------------------------------------------------------------------

/**
 * Point the runner's allowlist and write gate at one throwaway checkout and
 * select the harness. Returns a restore function so no phase leaks env into
 * the next one.
 */
function applyRunEnv(harness, checkout) {
  const overrides = {
    TACHI_CODING_ROOTS: checkout,
    TACHI_CODING_ALLOW_WRITE: "1",
    TACHI_OPENROUTER_HARNESS: harness,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function traceKindsOf(result) {
  return [...new Set((result?.trace ?? []).map((event) => event.kind))].sort();
}

async function writePhase(runCodingAgent, harness) {
  const checkout = await createCheckout(`${harness}-write`);
  const restoreEnv = applyRunEnv(harness, checkout);
  const started = Date.now();
  try {
    let result;
    let error;
    try {
      result = await runCodingAgent({
        agent: "openrouter",
        task: WRITE_TASK,
        mode: "write",
        cwd: checkout,
        // The write run is the "explicitly authorized write task that must
        // modify the requested checkout" the README carves out: with the
        // default isolation the edit lands in a throwaway worktree and every
        // post-run measurement below would read an untouched checkout.
        isolate: false,
        maxTurns: MAX_TURNS,
        timeoutMs: TIMEOUT_MS,
        // Default today, pinned here because the rubric counts trace events.
        visibility: "trace",
      });
    } catch (thrown) {
      error = conciseError(thrown);
    }
    const durationMs = Date.now() - started;
    const tests = result ? await runFixtureTests(checkout) : { passed: false, exitCode: null };
    const { changed, untracked } = await changedPaths(checkout);
    const touched = [...changed, ...untracked];
    return {
      harness,
      phase: "write",
      durationMs,
      exitStatus: result ? "ok" : "error",
      testsPassed: tests.passed,
      testExitCode: tests.exitCode,
      answerLength: result?.answer?.length ?? 0,
      traceKinds: traceKindsOf(result),
      changedPaths: changed,
      untrackedPaths: untracked,
      expectedPathsOnly: touched.includes(REQUIRED_WRITE_PATH) && touched.every((p) => EXPECTED_WRITE_PATHS.includes(p)),
      isolated: result?.isolated ?? null,
      ...(RUNNER_OVERRIDE ? { dryRun: true } : {}),
      ...(error ? { error } : {}),
    };
  } finally {
    restoreEnv();
    await disposeCheckout(checkout);
  }
}

async function reviewPhase(runCodingAgent, harness) {
  const checkout = await createCheckout(`${harness}-review`);
  const restoreEnv = applyRunEnv(harness, checkout);
  const started = Date.now();
  try {
    const before = await hashTree(checkout);
    let result;
    let error;
    try {
      result = await runCodingAgent({
        agent: "openrouter",
        task: REVIEW_TASK,
        mode: "review",
        cwd: checkout,
        isolate: true,
        maxTurns: MAX_TURNS,
        timeoutMs: TIMEOUT_MS,
        visibility: "trace",
      });
    } catch (thrown) {
      error = conciseError(thrown);
    }
    const durationMs = Date.now() - started;
    const after = await hashTree(checkout);
    const mutated = manifestDelta(before, after);
    return {
      harness,
      phase: "review",
      durationMs,
      exitStatus: result ? "ok" : "error",
      answerLength: result?.answer?.length ?? 0,
      traceKinds: traceKindsOf(result),
      checkoutUnchanged: mutated.length === 0,
      mutatedPaths: mutated.slice(0, 20),
      isolated: result?.isolated ?? null,
      ...(RUNNER_OVERRIDE ? { dryRun: true } : {}),
      ...(error ? { error } : {}),
    };
  } finally {
    restoreEnv();
    await disposeCheckout(checkout);
  }
}

// ---------------------------------------------------------------------------
// rubric
// ---------------------------------------------------------------------------

/**
 * The four task criteria both harnesses must clear for the comparison to mean
 * anything. `structuredTrace` is deliberately not one of them: it is the
 * tie-breaker codex alone has to win, not a bar hermes is expected to clear.
 */
const HARD_GATES = ["writeSucceeded", "testsPassed", "expectedPathsOnly", "checkoutUnchanged"];

/** Criteria are documented in docs/openrouter-harness-evaluation.md. */
function scoreHarness(write, review) {
  const criteria = {
    writeSucceeded: write.exitStatus === "ok",
    testsPassed: write.testsPassed === true,
    expectedPathsOnly: write.expectedPathsOnly === true,
    checkoutUnchanged: review.checkoutUnchanged === true,
    structuredTrace: write.traceKinds.length > 0 || review.traceKinds.length > 0,
  };
  const met = Object.values(criteria).filter(Boolean).length;
  return {
    criteria,
    met,
    total: Object.keys(criteria).length,
    allMet: met === Object.keys(criteria).length,
    hardGatesMet: HARD_GATES.every((gate) => criteria[gate] === true),
  };
}

function buildSummary(phases) {
  const scores = {};
  for (const harness of HARNESSES) {
    const write = phases.find((p) => p.harness === harness && p.phase === "write");
    const review = phases.find((p) => p.harness === harness && p.phase === "review");
    scores[harness] = {
      ...scoreHarness(write, review),
      writeDurationMs: write.durationMs,
      reviewDurationMs: review.durationMs,
    };
  }
  const bothCompleted = HARNESSES.every((h) => {
    const write = phases.find((p) => p.harness === h && p.phase === "write");
    const review = phases.find((p) => p.harness === h && p.phase === "review");
    return write.exitStatus === "ok" && review.exitStatus === "ok";
  });
  // Codex must earn the default outright, and only against a hermes run that
  // itself cleared the task: if the incumbent failed the hard gates the two runs
  // are not comparable (a broken fixture, a dead network), and a codex "win"
  // there measures the environment, not the harness. Anything short of
  // complete + hermes-clean + codex-clean + codex-traced leaves hermes in place.
  //
  // `bothCompleted` is checked first and is not redundant with the hard gates: a
  // review run that throws never touches the checkout, so `checkoutUnchanged`
  // comes back true and a harness whose review crashed could otherwise clear
  // every gate on the strength of having done nothing.
  const promoteCodex = bothCompleted
    && scores.hermes.hardGatesMet
    && scores.codex.hardGatesMet
    && scores.codex.criteria.structuredTrace;
  const reason = promoteCodex
    ? null
    : !bothCompleted
      ? "a harness phase did not complete — results not comparable"
      : !scores.hermes.hardGatesMet
        ? "hermes failed hard gates — environment not comparable"
        : !scores.codex.hardGatesMet
          ? "codex failed hard gates"
          : "codex emitted no trace events";
  const ranking = [...HARNESSES].sort((a, b) => scores[b].met - scores[a].met || HARNESSES.indexOf(a) - HARNESSES.indexOf(b));
  const integrityViolations = phases.filter((p) => p.phase === "review" && p.checkoutUnchanged === false).map((p) => p.harness);
  return {
    model: process.env.TACHI_OPENROUTER_CODING_MODEL?.trim() || process.env.OPENROUTER_MODEL?.trim(),
    node: process.version,
    ranAt: new Date().toISOString(),
    runner: RUNNER_OVERRIDE ? `override:${RUNNER_PATH}` : "dist",
    ...(RUNNER_OVERRIDE ? { dryRun: true } : {}),
    bothCompleted,
    scores,
    ranking,
    integrityViolations,
    recommendedDefault: promoteCodex ? "codex" : "hermes",
    rationale: promoteCodex
      ? "both harnesses completed every phase and cleared every hard gate, and codex additionally emitted structured trace events — promote codex to the default openrouter harness"
      : `hermes stays the default openrouter harness — ${reason}`,
    ...(reason ? { reason } : {}),
    rubric: "docs/openrouter-harness-evaluation.md",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const missing = await missingPrerequisites();
  if (missing.length > 0) {
    emit({
      error: "missing prerequisites",
      missing,
      hint: 'this evaluation makes billed OpenRouter calls; see docs/openrouter-harness-evaluation.md for the exact command',
      billed: false,
    });
    return 2;
  }

  const { runCodingAgent } = await import(pathToFileURL(RUNNER_PATH).href);

  const phases = [];
  for (const harness of HARNESSES) {
    note(`${harness}: write run (billed)…`);
    const write = await writePhase(runCodingAgent, harness);
    phases.push(write);
    emit(write);

    note(`${harness}: review run (billed)…`);
    const review = await reviewPhase(runCodingAgent, harness);
    phases.push(review);
    emit(review);
  }

  const summary = buildSummary(phases);
  emit({ summary });
  // A review run that mutated its checkout is a containment failure, not a
  // score — it must fail the command even if everything else looked fine.
  return summary.integrityViolations.length > 0 ? 1 : 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    emit({ error: "evaluation aborted", detail: conciseError(error) });
    process.exitCode = 1;
  },
);
