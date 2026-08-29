# OpenRouter Harness Evaluation

`run_coding_agent({ agent: "openrouter" })` is one public contract with two private
implementations behind it:

| Harness | CLI | Selected by |
|---|---|---|
| `hermes` (incumbent default) | `HERMES_CLI` or `hermes` | `TACHI_OPENROUTER_HARNESS=hermes` |
| `codex` (challenger) | `CODEX_CLI` or `codex` | `TACHI_OPENROUTER_HARNESS=codex` |

`TACHI_OPENROUTER_HARNESS` is read from `process.env` at spawn time and is an
**internal** selector. Callers keep asking for `agent: "openrouter"` with an
OpenRouter model; nothing in the tool schema changes when the winner changes.

This document is the decision procedure for picking the winner. It exists so the
choice rests on one reproducible measurement rather than on impressions from
ad-hoc runs.

## What the evaluation measures

`scripts/eval-openrouter-harness.mjs` runs both harnesses through the same two
phases against the same throwaway fixture, and prints NDJSON on stdout — one line
per harness/phase, then one `{"summary": …}` line.

The fixture (`scripts/fixtures/openrouter-harness/`) is a two-file ESM package
with one planted bug: `sum()` reduces with `total - value`, so three of the four
`node:test` assertions fail until the harness fixes it.

| Phase | Call | Question it answers |
|---|---|---|
| **write** | `mode: "write"`, `isolate: false`, `maxTurns: 20` | Can the harness find and fix a real bug in the requested checkout, and does it touch **only** what it should? |
| **review** | `mode: "review"`, `isolate: true`, `maxTurns: 20` | Is review actually non-mutating — is the requested checkout byte-identical afterwards? |

Each phase runs against its own fresh `mkdtemp` checkout: the fixture is copied
in, `git init` + a baseline commit make it a real repo (a `--worktree` run needs
one, and the diff needs a baseline), and `TACHI_CODING_ROOTS` is narrowed to that
directory so a wandering worker fails closed instead of reaching the real repo.
Every temp directory is deleted in a `finally`.

The write run passes `isolate: false` deliberately. It is the "explicitly
authorized write task that must modify the requested checkout" the README carves
out — under the default worktree isolation the fix would land in a throwaway
worktree and every post-run measurement would read an untouched checkout.

### Recorded fields

**write line** — `harness`, `phase`, `durationMs`, `exitStatus`, `testsPassed`,
`testExitCode`, `answerLength`, `traceKinds`, `changedPaths`, `untrackedPaths`,
`expectedPathsOnly`, `isolated`, and `error` when the run threw.

`changedPaths` is `git diff --name-only HEAD`; `untrackedPaths` is
`git ls-files --others --exclude-standard`, so a harness that litters state files
into the checkout is visible. `expectedPathsOnly` is true only when the union of
the two is non-empty and contained in `["src/sum.js"]`.

**review line** — `harness`, `phase`, `durationMs`, `exitStatus`, `answerLength`,
`traceKinds`, `checkoutUnchanged`, `mutatedPaths`, `isolated`, and `error`.
`checkoutUnchanged` compares a full sha256 manifest of the working tree (`.git`
excluded, so adds and deletes count too) taken before and after the run.

Answer text is never printed — only `answerLength`. The API key is redacted from
every string that reaches stdout, and error text is flattened and truncated to
500 characters because worker errors can echo model output.

## Rubric

**Codex becomes the default only when both harnesses complete and codex has all
five of:**

| # | Criterion | Source field |
|---|---|---|
| 1 | `writeSucceeded` — the write run returned without throwing | write `exitStatus === "ok"` |
| 2 | `testsPassed` — `node --test` is green in the checkout afterwards | write `testsPassed` |
| 3 | `expectedPathsOnly` — nothing outside `src/sum.js` was touched or added | write `expectedPathsOnly` |
| 4 | `checkoutUnchanged` — the review run left the checkout byte-identical | review `checkoutUnchanged` |
| 5 | `structuredTrace` — at least one structured trace event was surfaced | non-empty `traceKinds` in either phase |

**Otherwise hermes stays the default.** A tie, a partial pass, a harness that did
not complete, or a codex win on speed alone all leave hermes in place. Speed and
`answerLength` are reported for context; they never decide the outcome.

Criterion 5 is the substantive difference between the two harnesses today: the
hermes path returns a bare answer with an empty trace, while a codex-backed path
can stream structured `status` / `command` / `file_change` events. If codex wins
without it, the promotion buys nothing the incumbent does not already provide.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Evaluation completed. A harness failing its task is data, not a script failure. |
| `1` | Integrity violation — a review run mutated its checkout (`checkoutUnchanged: false`). |
| `2` | Missing prerequisites. Nothing was created, nothing was billed. |

## Running it (this spends money)

Every invocation makes real, billed OpenRouter calls — four agent runs in total
(write + review for each harness), each capped at 20 turns and 10 minutes. The
script refuses to start unless `OPENROUTER_API_KEY`, a model, both CLIs, and a
built `dist/` are all present, and it creates nothing before that check passes.

```bash
OPENROUTER_API_KEY="..." TACHI_OPENROUTER_CODING_MODEL="z-ai/glm-5.3-flash" npm run eval:openrouter-harness
```

`npm run eval:openrouter-harness` builds first, then runs the script against the
built runner — the same module path the MCP frontend uses, so the measured path
is the one callers get. Capture the output to compare runs:

```bash
OPENROUTER_API_KEY="..." TACHI_OPENROUTER_CODING_MODEL="z-ai/glm-5.3-flash" \
  npm run eval:openrouter-harness > eval-$(date +%Y%m%d).ndjson
```

The no-credentials path is safe to run at any time and is the only part covered
offline — it prints one JSON object naming the missing prerequisites and exits 2:

```bash
node scripts/eval-openrouter-harness.mjs; echo "exit=$?"
```

To exercise the checkout / diff / rubric plumbing itself without billing
anything, point `TACHI_EVAL_RUNNER` at a stub module exporting `runCodingAgent`.
Every result line and the summary are then stamped `"dryRun": true` and the
summary records `runner: "override:<path>"`, so a dry run can never be mistaken
for a real measurement:

```bash
OPENROUTER_API_KEY=dry-run TACHI_OPENROUTER_CODING_MODEL=stub/dry-run \
  TACHI_EVAL_RUNNER=/tmp/stub-runner.mjs node scripts/eval-openrouter-harness.mjs
```

Use one model for both harnesses in a given run. Comparing a codex run on one
model against a hermes run on another measures the models, not the harnesses.

## Results

**Pending live run.** No billed evaluation has been executed yet; hermes remains
the default `openrouter` harness until one is.

When the run happens, paste the NDJSON summary line here together with the model
id and date, then record the decision:

| Date | Model | hermes met | codex met | Both completed | Decision |
|---|---|---|---|---|---|
| _pending_ | _pending_ | _–_ | _–_ | _–_ | _hermes stays default_ |

## Cleanup condition

**Dated 2026-08-29.** After one release ships with the winning harness as the
default and no harness-specific regression is reported against it, delete the
losing harness's code path and the `TACHI_OPENROUTER_HARNESS` selector, leaving a
single implementation behind `agent: "openrouter"`.

The public contract does not change at cleanup: `agent: "openrouter"` keeps the
same arguments, the same model resolution (`TACHI_OPENROUTER_CODING_MODEL` →
`OPENROUTER_MODEL`), and the same review/write semantics. Only the private
selector and the dead branch go away. Remove this evaluation script and its
fixture at the same time — with one harness left there is nothing to compare.
