#!/usr/bin/env node
/**
 * A demo session for tachi-watch screenshots: a fictional project, a Claude Code
 * transcript with four tachibot calls, and the second brain's saved notes. Everything
 * is written under a throwaway HOME, so your real ~/.claude and ~/.tachi stay untouched.
 *
 *   node scripts/watch-demo.mjs /tmp/tw-demo
 *   HOME=/tmp/tw-demo node dist/cli.js watch --session demo-session --cwd /tmp/tw-demo/orders-api
 *
 * The pane that opens is the real one; only the data is staged.
 */
import fs from "node:fs";
import path from "node:path";

const home = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node scripts/watch-demo.mjs <empty dir to use as HOME>");
  process.exit(1);
}
const session = "demo-session";
const cwd = path.join(home, "orders-api");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// --- the project's memory: what the second brain checks calls against ---------
write(path.join(cwd, "CLAUDE.md"), `# orders-api

## Rules
- Webhook deliveries are retried for at most 24 hours in total, then dead-lettered.
- Every retry delay is capped at 15 minutes.
- Queue changes ship behind the \`retry_v2\` flag.
- No new dependencies without a note in docs/decisions/.
`);
write(path.join(cwd, ".remember", "now.md"), `# Now
Replacing the fixed 30s webhook retry with backoff. Decided on 2026-11-10: full jitter, not equal jitter.
`);

// --- the Claude Code transcript ------------------------------------------------
const t0 = Date.now() - 14 * 60_000;
let clock = t0;
const at = (secs) => new Date((clock += secs * 1000)).toISOString();
const lines = [];
const user = (text) => lines.push({ type: "user", timestamp: at(20), message: { content: text } });
const call = (id, tool, input, output, secs) => {
  lines.push({ type: "assistant", timestamp: at(4), message: { content: [{ type: "tool_use", id, name: `mcp__tachibot-mcp__${tool}`, input }] } });
  lines.push({ type: "user", timestamp: at(secs), message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } });
};
const say = (text) => lines.push({ type: "assistant", timestamp: at(3), message: { content: [{ type: "text", text }] } });

user("should the webhook retry queue use exponential backoff with jitter, or keep the fixed 30s schedule?");
call("toolu_demo_search", "grok_search", { query: "exponential backoff full jitter vs equal jitter thundering herd webhook retries" }, `Full jitter spreads retries across the whole window and gives the fewest collisions when many clients fail at once.
Equal jitter keeps a minimum wait but clusters more.

Sources
- https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- https://github.com/resilience4j/resilience4j
- https://sre.google/sre-book/handling-overload/`, 6);
call("toolu_demo_jury", "jury", { question: "Webhook retry queue: capped exponential backoff with full jitter, or the fixed 30s schedule?", mode: "panel" }, `JURY PANEL (3/3 responded)
- A: Grok (first-principles)
- B: DeepSeek (math)
- C: Kimi (edge cases)

VERDICT
Use capped exponential backoff with full jitter. A fixed 30s schedule synchronises every failed delivery, so a receiver that comes back is hit by all of them at once.

Start at 2s, double each time, and draw every delay from the whole window. Make ten attempts with each delay capped at one hour, then dead-letter and alert.

One juror dissents on the cap: an hour hides an outage for too long, so cap lower and alert sooner.`, 18);
say("The panel agrees on backoff with full jitter. I'll implement ten attempts with a one-hour cap.");

user("review the diff before I merge");
call("toolu_demo_review", "diff_review", { diff: "src/queue/retry.ts, src/queue/retry.test.ts", focus: "correctness" }, `NOT MERGEABLE
- [major] src/queue/retry.ts:48 — the delay cap is one hour; ten attempts run for more than five hours of waiting
- [major] src/queue/retry.ts:61 — jitter uses Math.random() * delay / 2: that is equal jitter, not full jitter
- [minor] src/queue/retry.test.ts:12 — no test pins the jitter bounds`, 11);
call("toolu_demo_plan", "planner_maker", { task: "fix the retry diff", mode: "checklist" }, `- [x] cap each delay at 15 minutes
- [x] switch to full jitter: random(0, delay)
- [ ] stop retrying after 24 hours in total
- [ ] test the jitter bounds with a seeded RNG
- [ ] ship behind retry_v2`, 9);

write(path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${session}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

// --- what the second brain said about those calls ------------------------------
let n = 0;
const card = (type, output, extra) => ({ key: `w${++n}`, type, source: "watch", depth: 0, ts: clock + n * 1000, status: "info", title: "watch", output, ...extra });
write(path.join(home, ".tachi", "watch", "sessions", `${session}.json`), JSON.stringify({
  savedAt: Date.now(),
  cards: [
    card("note", "The verdict's one-hour cap breaks a project rule: every retry delay is capped at 15 minutes.", { cite: "CLAUDE.md:5", about: "toolu_demo_jury" }),
    card("note", "Ten attempts at a one-hour cap can run past the 24-hour limit before dead-lettering.", { cite: "CLAUDE.md:4", about: "toolu_demo_jury" }),
    card("note", "The review is right about the jitter: memory records the decision for full jitter on 2026-11-10.", { cite: ".remember/now.md:2", about: "toolu_demo_review" }),
    card("answer", "Two things. The plan caps delays at 15 minutes, which matches CLAUDE.md, but nothing yet enforces the 24-hour total — that step is still unchecked. And the change has to ship behind the retry_v2 flag; the diff adds no flag check.", {
      input: "anything in memory Claude is ignoring?",
      followups: ["show me the rule about the flag", "what did the jury dissent on?", "draft the message for Claude"],
    }),
  ],
}));

console.log(`demo written under ${home}\n`);
console.log(`HOME=${home} node dist/cli.js watch --session ${session} --cwd ${cwd}`);
