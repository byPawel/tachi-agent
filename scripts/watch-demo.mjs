#!/usr/bin/env node
/**
 * A demo session for tachi-watch screenshots: a fictional project, a Claude Code
 * transcript with four tachibot calls, and the second brain's saved notes. Everything
 * is written under a throwaway HOME, so your real ~/.claude and ~/.tachi stay untouched.
 *
 *   node scripts/watch-demo.mjs /tmp/tw-demo            write the session, print the command
 *   node scripts/watch-demo.mjs /tmp/tw-demo --serve    also stand in for tachibot's trace server,
 *                                                       so the pane shows the model calls (Ctrl+C stops it)
 *
 * The pane that opens is the real one; only the data is staged.
 */
import fs from "node:fs";
import http from "node:http";
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
// the same calls as tachibot's trace would report them: a tool span, and the model calls under it
const trace = [];
let span = 0;
const traced = (tool, start, secs, models) => {
  const id = `t${++span}`;
  trace.push({ type: "span.start", id, kind: "tool", name: tool, ts: start + 40 });
  models.forEach(([name, share, tokensIn, tokensOut], i) => {
    const mid = `${id}m${i}`;
    const begin = start + 200 + i * 150;
    const ms = Math.round(secs * 1000 * share);
    trace.push({ type: "span.start", id: mid, parentId: id, kind: "model", name, ts: begin });
    trace.push({ type: "usage", id: `${mid}u`, parentId: mid, name, ts: begin + ms - 5, tokensIn, tokensOut });
    trace.push({ type: "span.end", id: mid, parentId: id, kind: "model", name, ts: begin + ms, ms, output: "ok" });
  });
  trace.push({ type: "span.end", id, kind: "tool", name: tool, ts: start + secs * 1000 - 60, ms: secs * 1000 - 100 });
};
const user = (text) => lines.push({ type: "user", timestamp: at(20), message: { content: text } });
const call = (id, tool, input, output, secs, models = []) => {
  lines.push({ type: "assistant", timestamp: at(4), message: { content: [{ type: "tool_use", id, name: `mcp__tachibot-mcp__${tool}`, input }] } });
  traced(tool, clock, secs, models);
  lines.push({ type: "user", timestamp: at(secs), message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } });
};
const say = (text) => lines.push({ type: "assistant", timestamp: at(3), message: { content: [{ type: "text", text }] } });

user("should the webhook retry queue use exponential backoff with jitter, or keep the fixed 30s schedule?");
call("toolu_demo_search", "grok_search", { query: "exponential backoff full jitter vs equal jitter thundering herd webhook retries" }, `Full jitter spreads retries across the whole window and gives the fewest collisions when many clients fail at once.
Equal jitter keeps a minimum wait but clusters more.

Sources
- https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- https://github.com/resilience4j/resilience4j
- https://sre.google/sre-book/handling-overload/`, 6, [["grok", 0.9, 1840, 612]]);
call("toolu_demo_jury", "jury", { question: "Webhook retry queue: capped exponential backoff with full jitter, or the fixed 30s schedule?", mode: "panel" }, `JURY PANEL (3/3 responded)
- A: Grok (first-principles)
- B: DeepSeek (math)
- C: Kimi (edge cases)

VERDICT
Use capped exponential backoff with full jitter. A fixed 30s schedule synchronises every failed delivery, so a receiver that comes back is hit by all of them at once.

Start at 2s, double each time, and draw every delay from the whole window. Make ten attempts with each delay capped at one hour, then dead-letter and alert.

One juror dissents on the cap: an hour hides an outage for too long, so cap lower and alert sooner.`, 18, [["grok", 0.55, 2210, 940], ["deepseek", 0.7, 2190, 1120], ["kimi", 0.62, 2204, 876], ["gemini", 0.22, 4630, 388]]);
say("The panel agrees on backoff with full jitter. I'll implement ten attempts with a one-hour cap.");

user("review the diff before I merge");
call("toolu_demo_review", "diff_review", { diff: "src/queue/retry.ts, src/queue/retry.test.ts", focus: "correctness" }, `NOT MERGEABLE
- [major] src/queue/retry.ts:48 — the delay cap is one hour; ten attempts run for more than five hours of waiting
- [major] src/queue/retry.ts:61 — jitter uses Math.random() * delay / 2: that is equal jitter, not full jitter
- [minor] src/queue/retry.test.ts:12 — no test pins the jitter bounds`, 11, [["kimi", 0.6, 5120, 702], ["deepseek", 0.66, 5098, 815], ["openai", 0.58, 5110, 690], ["gemini", 0.25, 7480, 301]]);
call("toolu_demo_plan", "planner_maker", { task: "fix the retry diff", mode: "checklist" }, `- [x] cap each delay at 15 minutes
- [x] switch to full jitter: random(0, delay)
- [ ] stop retrying after 24 hours in total
- [ ] test the jitter bounds with a seeded RNG
- [ ] ship behind retry_v2`, 9, [["deepseek", 0.7, 3020, 540], ["gemini", 0.2, 3410, 212]]);

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
const run = `HOME=${home} node dist/cli.js watch --session ${session} --cwd ${cwd}`;
if (!process.argv.includes("--serve")) {
  console.log(run);
  process.exit(0);
}

// --- a stand-in for tachibot's trace server: replays the spans above over SSE ----
const token = "demo";
const server = http.createServer((req, res) => {
  if (!req.url?.startsWith(`/events?t=${token}`)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of trace) res.write(`data: ${JSON.stringify(e)}\n\n`);
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  // the pane follows only the tachibot its own Claude started: this process plays both
  write(path.join(home, "trace", "demo.json"), JSON.stringify({ pid: process.pid, ppid: process.pid, port, token, cwd, startedAt: Date.now() }));
  console.log(`TACHI_WATCH_TRACE_DIR=${path.join(home, "trace")} ${run} --claude-pid ${process.pid}`);
  console.log("\nserving the model trace — Ctrl+C to stop");
});
