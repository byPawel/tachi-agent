import { homedir } from "node:os";
import fs from "node:fs";
/**
 * `tachi-agent watch` — a side agent in a terminal split next to Claude Code.
 *
 * The controller (this file) wires the live sources (Claude transcript, tachibot
 * trace), the reviewer (brain + memory excerpts + optional dokoro recall) and
 * the approval flow; ui.tsx renders its state with Ink.
 *
 *   tachi-agent watch --open                  # from Claude: `! tachi-agent watch --open`
 *   tachi-agent watch --session <id> [--cwd <dir>] [--target <cmux surface>] [--brain codex]
 */
import { execFile } from "node:child_process";
import { claudeTranscriptPath, type WatchEvent } from "./events.js";
import { tailClaudeTranscript, followTachibot, findTachibot } from "./sources.js";
import { CALL_REVIEW_SYSTEM_PROMPT, WATCHER_SYSTEM_PROMPT, buildCallReviewPrompt, buildReviewPrompt, formatLog, parseReview, shouldReview, type ReviewReason } from "./policy.js";
import { loadSaved, saveCards, loadLabels, saveLabels } from "./persist.js";
import { splitFollowUps } from "./components.js";
import { loadTechniques, techniqueMessage, type Technique } from "./prompts.js";
import { cleanText, buildInboxCommand, buildOpenCommand, buildSendCommand, defaultTarget, parseInbox, herdrPaneId, watchArgv, type WatchLaunch } from "./terminal.js";
import { DEFAULT_CONFIG, isLayout, loadWatchConfig, type WatchConfig, type WatchLayout } from "./config.js";
import { makeBrain, type Brain } from "./brain.js";
import { memoryFiles, readMemoryDocs, selectSnippets } from "./memory.js";
import { EMPTY, applyEvent, watchCard, type Card, type CardState } from "./store.js";
import type { Memory } from "../types.js";

const WINDOW = 60;

/** The most a proposal to Claude may hold: it must fit on screen whole when you approve it. */
export const PROPOSAL_MAX = 800;

/**
 * What you approve is exactly what is sent: no ANSI, no control characters, no bidi or
 * zero-width format characters (they can hide or reorder text), capped to PROPOSAL_MAX.
 */
export function cleanProposal(text: string): string {
  const t = text
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/\n\s*\n+/g, "\n") // no blank-line padding that pushes text out of view
    .trim();
  const lines = t.split("\n");
  const capped = lines.length > 12 ? `${lines.slice(0, 12).join("\n")}…` : t;
  return capped.length > PROPOSAL_MAX ? `${capped.slice(0, PROPOSAL_MAX - 1)}…` : capped;
}

export interface WatchArgs extends Partial<WatchLaunch> {
  open: boolean;
  brain?: string;
}

export function parseWatchArgs(argv: string[], env: Record<string, string | undefined> = process.env): WatchArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const args: WatchArgs = {
    open: argv.includes("--open"),
    session: get("--session") ?? env.CLAUDE_CODE_SESSION_ID,
    cwd: get("--cwd") ?? process.cwd(),
    target: get("--target"),
  };
  const brain = get("--brain");
  if (brain) args.brain = brain;
  const claudePid = Number(get("--claude-pid"));
  if (Number.isInteger(claudePid) && claudePid > 0) args.claudePid = claudePid;
  return args;
}

/** Open the watcher in a split next to the calling (Claude) pane. */
export async function openWatchSplit(args: WatchArgs, env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!args.session) {
    console.error("✖ no Claude session id — run this from inside Claude Code (`! tachi-agent watch --open`) or pass --session <id>.");
    process.exit(1);
  }
  const claudePid = Number(env.CLAUDE_PID);
  const launch: WatchLaunch = {
    session: args.session,
    cwd: args.cwd ?? process.cwd(),
    target: args.target ?? defaultTarget(env),
    ...(Number.isInteger(claudePid) && claudePid > 0 ? { claudePid } : {}),
  };
  const argv = watchArgv(process.execPath, process.argv[1], launch);
  if (args.brain) argv.push("--brain", args.brain);
  const plan = buildOpenCommand(argv, env);
  if (plan.kind === "herdr") {
    // two steps: split (returns the new pane id as JSON), then run the watcher in it
    execFile(plan.split.cmd, plan.split.args, (err, stdout) => {
      const pane = err ? undefined : herdrPaneId(String(stdout));
      if (!pane) {
        console.error(`✖ could not open herdr split: ${err?.message ?? "no pane id in response"}`);
        return;
      }
      const run = plan.run(pane);
      execFile(run.cmd, run.args, (runErr) => {
        if (runErr) console.error(`✖ herdr pane run failed: ${runErr.message}`);
        else console.log(`tachi-watch opened in a herdr split → watching session ${launch.session.slice(0, 8)}`);
      });
    });
    return;
  }
  if (plan.kind === "manual") {
    console.log("This terminal can't be split from a script. Split it yourself (e.g. Cmd+D) and run:\n");
    console.log(`  ${plan.shell}\n`);
    return;
  }
  await new Promise<void>((resolve) => {
    execFile(plan.command.cmd, plan.command.args, (err) => {
      if (err) console.error(`✖ could not open ${plan.kind} split: ${err.message}`);
      else console.log(`tachi-watch opened in a ${plan.kind} split → watching session ${launch.session.slice(0, 8)}`);
      resolve();
    });
  });
}

export interface WatchState {
  cards: Card[];
  startedAt: number;
  /** Tool calls still needed before a cadence review. */
  untilReview: number;
  session: string;
  cwd: string;
  brain: string;
  tachibot: string;
  memory: string;
  target?: string;
  reviewing: boolean;
  reviewingKey?: string;
  thinking: boolean;
  /** The question the brain is answering right now (shown in the chat at once). */
  asking?: { question: string; since: number };
  proposal?: string;
  configFrom: string[];
  /** auto: three columns at ≥140 cols · split: always · stack: never */
  layout: WatchLayout;
  /** what the second brain reads, relative to the project (dokoro files included) */
  memoryList: string[];
  /** dokoro search connected (its index is queried per review) */
  dokoroSearch: boolean;
  /** mouse wheel scrolling (on by default; "mouse": false in watch.json or /mouse off) */
  mouse: boolean;
  /** your prompts this session — the calls are grouped under the question that started them */
  prompts: Array<{ ts: number; text: string }>;
  /** your own names for groups, keyed by the prompt's ts */
  labels: Record<string, string>;
  /** tachibot's prompt-technique catalog (PROMPTS tab), loaded on first open */
  techniques?: Technique[];
  techniquesFrom?: string;
  /** Claude just used a prompt-technique tool: the PROMPTS tab opens on it (name) or filtered (query) */
  focusTechnique?: { ts: number; name?: string; query?: string };
  /** the brain's pick of techniques for a task (PROMPTS tab, ctrl+r) */
  recommended?: { task: string; picks: Array<{ name: string; why: string }>; busy?: boolean };
}

export class WatchController {
  private state: WatchState;
  private listeners = new Set<() => void>();
  private recent: WatchEvent[] = [];
  /** Every user prompt this session — the first one (the original ask) never scrolls out. */
  private prompts: WatchEvent[] = [];
  private fresh: WatchEvent[] = [];
  /** Finished tachibot calls waiting for review (card keys, oldest first). */
  private queue: string[] = [];
  private lastSessionReviewAt: number;
  private saveTimer?: NodeJS.Timeout;
  private lastReviewAt: number;
  private readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private brain: Brain;
  private cardState: CardState = EMPTY;
  private dokoro?: Memory;
  private closeRuntime?: () => Promise<void>;

  constructor(private readonly args: Required<Pick<WatchArgs, "session" | "cwd">> & WatchArgs, private readonly config: WatchConfig) {
    this.lastReviewAt = this.startedAt;
    this.lastSessionReviewAt = this.startedAt;
    const spec = args.brain ?? config.brain;
    let brainError: string | undefined;
    try {
      this.brain = makeBrain(spec, args.cwd);
    } catch (err) {
      brainError = err instanceof Error ? err.message : String(err);
      this.brain = makeBrain(DEFAULT_CONFIG.brain, args.cwd);
    }
    const files = readMemoryDocs(memoryFiles(args.cwd, config.memory.files), args.cwd);
    this.state = {
      cards: [],
      startedAt: this.startedAt,
      untilReview: config.review.everyToolCalls,
      session: args.session,
      cwd: args.cwd,
      brain: this.brain.name,
      tachibot: "waiting",
      memory: `${files.length} files`,
      memoryList: memoryFiles(args.cwd, config.memory.files).filter((f) => fs.existsSync(f)).map((f) => f.replace(`${args.cwd}/`, "").replace(homedir(), "~")),
      dokoroSearch: false,
      target: args.target,
      reviewing: false,
      thinking: false,
      configFrom: config.loadedFrom,
      layout: config.layout,
      mouse: config.mouse,
      prompts: [],
      labels: loadLabels(args.session),
    };
    // resume: the brain's notes, answers and your questions from earlier runs of this session
    const saved = loadSaved(args.session);
    if (saved.length) {
      this.cardState = { ...this.cardState, cards: saved };
      this.state = { ...this.state, cards: saved };
    }
    if (brainError) this.say("status", `${brainError} — using ${DEFAULT_CONFIG.brain}`);
    if (saved.length) this.say("status", `resumed ${saved.length} notes/answers from earlier`);
    if (!args.target) this.say("status", "no Claude pane target — approved messages will be shown for copy-paste");
  }

  // --- store plumbing (useSyncExternalStore contract) -----------------------
  getState = (): WatchState => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private notifyTimer?: NodeJS.Timeout;
  /** State changes are coalesced: listeners (the Ink UI) re-render at most every 40ms. */
  private set(patch: Partial<WatchState>): void {
    this.state = { ...this.state, ...patch };
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      for (const fn of this.listeners) fn();
    }, 40);
  }
  private say(type: "note" | "answer" | "status", text: string, cite?: string, about?: string, question?: string, followups?: string[], context?: string[]): void {
    const card = watchCard(type, text, cite, about);
    if (context?.length) card.context = context;
    if (question) card.input = question;
    if (followups?.length) card.followups = followups;
    this.cardState = { ...this.cardState, cards: [...this.cardState.cards, card].slice(-this.config.maxCards) };
    if (type !== "status") this.scheduleSave();
    this.set({ cards: this.cardState.cards });
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      saveCards(this.args.session, this.cardState.cards);
    }, 500);
  }

  // --- lifecycle ------------------------------------------------------------
  start(): void {
    const signal = this.controller.signal;
    void tailClaudeTranscript(claudeTranscriptPath(this.args.cwd, this.args.session), this.onEvent, signal);
    void followTachibot(this.args.cwd, this.onEvent, (s) => this.set({ tachibot: s.replace(/^tachibot: /, "") }), signal, this.args.claudePid);
    // Live: every finished tachibot call is reviewed on its own, newest first if
    // several piled up (older ones are dropped — the latest answer matters most).
    const timer = setInterval(() => {
      if (this.state.reviewing || this.queue.length === 0) return;
      if (Date.now() - this.lastReviewAt < Math.min(this.config.review.minIntervalMs, 10_000)) return;
      const key = this.queue[this.queue.length - 1];
      this.queue = [];
      void this.review("tachibot", key);
    }, 1000);
    // Commentary on the session itself: what Claude is doing vs what you asked + memory.
    const sessionTimer = setInterval(() => {
      if (this.state.reviewing) return;
      const reason = shouldReview(this.fresh, this.recent, Date.now() - this.lastSessionReviewAt, this.config.review);
      if (reason) void this.reviewSession(reason);
    }, 2000);
    signal.addEventListener("abort", () => clearInterval(sessionTimer));
    signal.addEventListener("abort", () => clearInterval(timer));
    void this.connectDokoro();
    void this.loadTechniques(); // PROMPTS shows its count from the start
  }

  async stop(): Promise<void> {
    this.controller.abort();
    saveCards(this.args.session, this.cardState.cards);
    await this.closeRuntime?.().catch(() => undefined);
  }

  /** dokoro recall when DOKORO_CMD or config memory.dokoroCmd is set — the markdown memory works without it. */
  private async connectDokoro(): Promise<void> {
    if (!process.env.DOKORO_CMD && this.config.memory.dokoroCmd) process.env.DOKORO_CMD = this.config.memory.dokoroCmd;
    if (!process.env.DOKORO_CMD) return;
    delete process.env.TACHIBOT_CMD; // the watcher needs memory only, not a second tachibot
    try {
      const { buildAgentFromEnv } = await import("../runtime.js");
      const rt = await buildAgentFromEnv({ allow: ["dokoro_"] });
      this.dokoro = rt.memory;
      this.closeRuntime = () => rt.close();
      if (rt.memory) this.set({ memory: `${this.state.memory} + dokoro`, dokoroSearch: true });
    } catch (err) {
      this.say("status", `dokoro unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }

  private onEvent = (e: WatchEvent): void => {
    if (e.kind === "prompt") {
      this.prompts.push(e);
      this.state = { ...this.state, prompts: [...this.state.prompts, { ts: e.ts, text: e.text }] };
    }
    this.recent.push(e);
    if (this.recent.length > WINDOW) this.recent.shift();
    if (e.ts >= this.startedAt) this.fresh.push(e); // backfill is context, never a trigger
    // The pane lists tachibot calls only: plain Claude tools, prompts and replies stay in
    // `recent` (the reviewer's context) but never take card slots from tachibot calls.
    const plain = e.source === "claude" && (e.kind === "prompt" || e.kind === "text" || (e.kind === "tool" && e.via !== "tachibot"));
    if (!plain) this.cardState = applyEvent(this.cardState, e, this.config.maxCards);
    // Claude asked tachibot about prompt techniques → point the PROMPTS tab at it (live events only)
    if (e.kind === "tool" && e.via === "tachibot" && e.ts >= this.startedAt && /prompt_technique/.test(e.tool ?? "")) {
      const args = e.inputFull ?? e.input ?? "";
      const name = /^technique:\s*(\S+)/m.exec(args)?.[1]?.replace(/["',]/g, "");
      const query = /^query:\s*(.+)$/m.exec(args)?.[1];
      this.state = { ...this.state, focusTechnique: { ts: e.ts, name: name && name !== "auto" ? name : undefined, query: !name || name === "auto" ? query : undefined } };
    }
    if ((e.kind === "tool-ok" || e.kind === "tool-error") && e.ts >= this.startedAt) {
      const card = this.cardState.cards.find((c) => (e.id ? c.key === e.id : !!e.taskId && c.taskId === e.taskId));
      if (card?.via === "tachibot") this.queue.push(card.key);
    }
    const toolsSince = this.fresh.filter((f) => f.kind === "tool").length;
    this.set({ cards: this.cardState.cards, untilReview: Math.max(0, this.config.review.everyToolCalls - toolsSince) });
  };

  // --- reviewing ------------------------------------------------------------
  /** Review one tachibot call (default: the latest) against memory + the user's recent words. */
  async review(reason: ReviewReason, key?: string): Promise<void> {
    if (this.state.reviewing) return;
    const calls = this.cardState.cards.filter((c) => c.via === "tachibot");
    const call = key ? calls.find((c) => c.key === key) : calls[calls.length - 1];
    if (!call) {
      if (reason === "manual") this.say("status", "no tachibot call to review yet");
      return;
    }
    this.lastReviewAt = Date.now();
    this.set({ reviewing: true, reviewingKey: call.key });
    try {
      const models = this.cardState.cards
        .filter((c) => c.type === "span" && c.depth > 0 && this.cardState.cards.indexOf(c) > this.cardState.cards.indexOf(call))
        .slice(0, 8)
        .map((c) => `${c.title} ${c.status}${c.cite ? ` → ${c.cite}` : ""}`);
      const prompts = this.userAskList();
      const query = `${call.title}\n${call.inputFull ?? call.input ?? ""}\n${(call.full ?? call.output ?? "").slice(0, 3000)}\n${prompts.join("\n")}`;
      const docs = readMemoryDocs(memoryFiles(this.args.cwd, this.config.memory.files), this.args.cwd);
      const snippets = selectSnippets(docs, query, this.config.memory.maxSnippets);
      const dokoro = this.dokoro ? await this.dokoro.recall(query.slice(0, 1500), this.controller.signal).catch(() => "") : "";
      const prompt = buildCallReviewPrompt(
        { title: call.title, input: call.inputFull ?? call.input, output: call.full ?? call.output, status: call.status, models },
        prompts, snippets, dokoro,
      );
      const result = parseReview(await this.brain.ask(CALL_REVIEW_SYSTEM_PROMPT, prompt, this.controller.signal));
      for (const n of result.notes) this.say("note", n.text, n.source, call.key);
      if (result.flag) this.set({ proposal: cleanProposal(result.flag) });
      if (!result.notes.length && !result.flag) this.say("status", `✓ ${call.title}: nothing contradicts memory`, undefined, call.key);
    } catch (err) {
      this.say("status", `review failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.set({ reviewing: false, reviewingKey: undefined });
    }
  }

  /** The original ask + the latest 5 prompts (deduped), for every review. */
  private userAskList(): string[] {
    const list = this.prompts.length > 6 ? [this.prompts[0], ...this.prompts.slice(-5)] : this.prompts;
    return list.map((e) => e.text);
  }
  private userAsks(): string {
    return this.userAskList().map((t) => `- ${t}`).join("\n");
  }

  /** Session commentary: what Claude is doing, checked against what you asked and memory. */
  async reviewSession(reason: ReviewReason): Promise<void> {
    if (this.state.reviewing) return;
    this.lastSessionReviewAt = Date.now();
    this.fresh = [];
    this.set({ reviewing: true });
    try {
      const query = formatLog(this.recent.slice(-20));
      const docs = readMemoryDocs(memoryFiles(this.args.cwd, this.config.memory.files), this.args.cwd);
      const snippets = selectSnippets(docs, query, this.config.memory.maxSnippets);
      const dokoro = this.dokoro ? await this.dokoro.recall(query.slice(0, 1500), this.controller.signal).catch(() => "") : "";
      const asked = this.userAsks();
      const prompt = `${asked ? `What the user asked (first message, then latest):\n${asked}\n\n` : ""}${buildReviewPrompt(reason, this.recent, snippets, dokoro)}`;
      const result = parseReview(await this.brain.ask(WATCHER_SYSTEM_PROMPT, prompt, this.controller.signal));
      for (const n of result.notes) this.say("note", n.text, n.source);
      if (result.flag) this.set({ proposal: cleanProposal(result.flag) });
    } catch (err) {
      this.say("status", `session review failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.set({ reviewing: false });
    }
  }

  /** Ask the second brain — about the selected tachibot call when there is one. */
  async ask(question: string, key?: string): Promise<void> {
    if (this.state.asking) {
      this.say("status", "still answering the last question — wait for it");
      return;
    }
    this.set({ thinking: true, asking: { question, since: Date.now() } });
    try {
      const docs = readMemoryDocs(memoryFiles(this.args.cwd, this.config.memory.files), this.args.cwd);
      const history = this.cardState.cards
        .filter((c) => c.type === "answer" && c.input)
        .slice(-10)
        .map((c) => `Q: ${c.input}\nA: ${c.output ?? ""}`)
        .join("\n\n");
      const calls = this.cardState.cards.filter((c) => c.via === "tachibot");
      const call = (key && calls.find((c) => c.key === key)) || calls[calls.length - 1];
      const callText = call ? `${call.title}\nINPUT:\n${call.inputFull ?? call.input ?? ""}\nOUTPUT:\n${call.full ?? call.output ?? ""}` : "";
      const snippets = selectSnippets(docs, `${question}\n${callText.slice(0, 3000)}`, this.config.memory.maxSnippets);
      const dokoro = this.dokoro ? await this.dokoro.recall(question, this.controller.signal).catch(() => "") : "";
      const system = "You are tachi-watch, a second brain next to the user while Claude Code works. You have the project's memory and the tachibot call they are looking at. Facts about this setup: dokoro is the user's memory layer (an MCP server) whose recall you are given, not another project; a message to Claude marked delivered via claude.prompt-submit or claude.wake was injected by cmux into Claude's context through a hook — delivery IS receipt. Answer briefly and concretely in markdown; cite memory as [source]. End with one last line: FOLLOWUPS: <q1> | <q2> | <q3> — up to three short questions the user may want to ask next.";
      const user = [
        snippets.length ? `Project memory excerpts:\n${snippets.map((s) => `[${s.source}]\n${s.text}`).join("\n\n")}` : "",
        dokoro.trim() ? `dokoro recall:\n${dokoro.trim().slice(0, 3000)}` : "",
        callText ? `tachibot call in view:\n${callText}` : "",
        `What Claude did recently:\n${formatLog(this.recent.slice(-15))}`,
        history ? `Our conversation so far:\n${history}` : "",
        `Question: ${question}`,
      ].filter(Boolean).join("\n\n");
      const { text, followups } = splitFollowUps((await this.brain.ask(system, user, this.controller.signal)).trim());
      const context = [...(call ? [call.title.replace(/^tachibot · /, "")] : []), ...snippets.map((sn) => sn.source).slice(0, 4), ...(dokoro.trim() ? ["dokoro"] : [])];
      this.say("answer", text, undefined, call?.key, question, followups, context);
    } catch (err) {
      // into the chat, where the question is — not just the header status line
      this.say("answer", `✗ ${err instanceof Error ? err.message : err}`, "error", undefined, question);
    } finally {
      this.set({ thinking: false, asking: undefined });
    }
  }

  // --- prompts tab -------------------------------------------------------------
  private loadingTechniques = false;
  /** Load the technique catalog once (the PROMPTS tab calls this when opened). */
  async loadTechniques(): Promise<void> {
    if (this.state.techniques || this.loadingTechniques) return;
    this.loadingTechniques = true;
    try {
      const entry = findTachibot(this.args.cwd, undefined, this.args.claudePid);
      const { list, from } = await loadTechniques(this.args.cwd, entry ? { port: entry.port, token: entry.token } : undefined);
      this.set({ techniques: list, techniquesFrom: from });
    } catch (err) {
      this.say("status", err instanceof Error ? err.message : String(err));
      this.set({ techniques: [] });
    } finally {
      this.loadingTechniques = false;
    }
  }

  /** Ask the brain which 3 techniques fit a task, from tachibot's catalog. */
  async recommendTechniques(task: string): Promise<void> {
    const list = this.state.techniques ?? [];
    const what = task.trim() || this.prompts[this.prompts.length - 1]?.text || "";
    if (!list.length || !what) return;
    this.set({ recommended: { task: what, picks: [], busy: true } });
    try {
      const catalog = list.map((t) => `${t.name} — ${t.useWhen}`).join("\n");
      const answer = await this.brain.ask(
        "You pick prompt techniques. From the catalog, choose the 3 that best fit the task. Reply with exactly 3 lines, best first: <name> | <one short reason>. Use names exactly as listed.",
        `Task: ${what}\n\nCatalog (name — use when):\n${catalog}`,
        this.controller.signal,
      );
      const names = new Set(list.map((t) => t.name));
      const picks = answer.split("\n")
        .map((l) => l.replace(/^[\s\d.)*•-]+/, "").replace(/\*\*/g, ""))
        .map((l) => { const [n, ...why] = l.split("|"); return { name: n.trim().replace(/[`"]/g, ""), why: why.join("|").trim() }; })
        .filter((p) => names.has(p.name))
        .slice(0, 3);
      this.set({ recommended: { task: what, picks } });
      if (!picks.length) this.say("status", "the brain named no technique from the catalog — try rephrasing the task");
    } catch (err) {
      this.set({ recommended: undefined });
      this.say("status", `recommend failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Propose "apply technique X to <task>" to Claude — you approve it with ctrl+s like any proposal. */
  proposeTechnique(t: Technique, task: string): void {
    // your last real question — never a harness-injected turn (Stop hook, compaction notice…)
    const harness = /^(A session-scoped Stop hook|Stop hook feedback|This session is being continued|\[SYSTEM NOTIFICATION|Caveat:|<)/;
    const last = [...this.prompts].reverse().find((p) => !harness.test(p.text.trim()))?.text ?? "";
    this.set({ proposal: cleanProposal(techniqueMessage(t, task || last.replace(/\[Image[^\]]*\]/g, "").trim())) });
  }

  // --- approval + commands ----------------------------------------------------
  send(text: string): void {
    this.set({ proposal: undefined });
    const cmd = buildSendCommand(this.args.target, text, process.env);
    if (!cmd) {
      this.say("status", `copy to Claude: ${text}`);
      return;
    }
    // The outcome goes into the chat. "sent" is only queued: cmux hands it to Claude
    // at Claude's next hook, so the inbox is polled until it says delivered/read.
    execFile(cmd.cmd, cmd.args, (err, stdout) => {
      if (err) {
        // a failed send comes back as the proposal: ^S retries it, Esc drops it
        this.say("answer", `✗ send failed: ${err.message}`, "error", undefined, `/send ${text}`);
        this.say("status", "✗ send failed — ^S to retry, Esc to drop");
        this.set({ proposal: cleanProposal(text) });
        return;
      }
      const id = /"id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1];
      this.say("answer", `→ queued for Claude${id ? ` (${id.slice(0, 8)})` : ""} — waiting for Claude to receive it…`, "sent", undefined, `/send ${text}`);
      this.say("status", "→ sent to Claude — waiting for the receipt…");
      if (id) this.awaitReceipt(id, text);
    });
  }

  /** Poll the target's cmux inbox until the message is delivered (or give up after 10 min). */
  private awaitReceipt(id: string, text: string): void {
    const inbox = buildInboxCommand(this.args.target, process.env);
    if (!inbox) return;
    const until = Date.now() + 10 * 60_000;
    const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const tick = () => {
      if (this.controller.signal.aborted) return;
      execFile(inbox.cmd, inbox.args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const r = err ? undefined : parseInbox(stdout, id);
        if (r && r.state !== "queued") {
          this.say("answer", `✓ Claude received it${r.via ? ` via ${r.via}` : ""} (${r.state}): ${short}`, "received");
          this.say("status", `✓ Claude received it${r.via ? ` · ${r.via.replace(/^claude\./, "")}` : ""}`);
          return;
        }
        if (Date.now() > until) return this.say("answer", `✗ not received after 10 min (still ${r?.state ?? "unknown"}): ${short}`, "error");
        setTimeout(tick, 2000);
      });
    };
    setTimeout(tick, 1000);
  }

  cancelProposal(): void {
    if (this.state.proposal) this.say("status", "proposal cancelled");
    this.set({ proposal: undefined });
  }

  /** Returns false when the UI should exit. `selected` = the tachibot call in view. */
  handleLine(line: string, selected?: string): boolean {
    const t = cleanText(line);
    if (!t) return true;
    if (t === "/quit" || t === "/exit") return false;
    if (t === "/review") void this.review("manual", selected);
    else if (t === "/send" || t === "@claude" || t === ">") this.say("status", "@claude <text> (or /send, or > ) — sends the text to Claude");
    else if (/^(@claude|>)\s+/i.test(t)) this.send(t.replace(/^(@claude|>)\s+/i, ""));
    else if (t.startsWith("/send ")) this.send(t.slice(6).trim());
    else if (t.startsWith("/brain")) {
      const spec = t.slice(6).trim();
      if (!spec) this.say("status", `brain: ${this.brain.name} — /brain claude[:model] | codex | gemini | grok | driver[:name]`);
      else {
        try {
          this.brain = makeBrain(spec, this.args.cwd);
          this.set({ brain: this.brain.name });
          this.say("status", `brain → ${this.brain.name}`);
        } catch (err) {
          this.say("status", err instanceof Error ? err.message : String(err));
        }
      }
    } else if (t === "/note-models") {
      this.say("status", this.state.tachibot.startsWith("connected")
        ? "no model calls traced for this call"
        : "no model calls to show — tachibot's trace is off until Claude Code restarts (TACHIBOT_TRACE_UI=1)");
    } else if (t.startsWith("/label")) {
      // rename the question group the selected call belongs to ("/label" alone clears it)
      const card = this.cardState.cards.find((c) => c.key === selected);
      const group = card ? [...this.state.prompts].reverse().find((p) => p.ts <= card.ts) : undefined;
      if (!group) this.say("status", "select a call first — /label names the question group it belongs to");
      else {
        const labels = { ...this.state.labels };
        const text = t.slice(6).trim();
        if (text) labels[String(group.ts)] = text;
        else delete labels[String(group.ts)];
        this.set({ labels });
        saveLabels(this.args.session, labels);
        this.say("status", text ? `group → ${text}` : "group label cleared");
      }
    } else if (t === "/mouse off" || t === "/mouse on") {
      const on = t.endsWith("on");
      process.stdout.write(on ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
      this.set({ mouse: on });
      this.say("status", on ? "mouse on — wheel scrolls, Shift-drag selects text" : "mouse off — plain drag selects text, keys scroll");
    } else if (t.startsWith("/layout")) {
      const v = t.slice(7).trim();
      if (isLayout(v)) {
        this.set({ layout: v });
        this.say("status", `layout → ${v}`);
      } else this.say("status", `layout: ${this.state.layout} — /layout auto | split | stack (default in ~/.tachi/watch.json "layout")`);
    } else if (t === "/help") {
      this.say("status", "✓ ok · ✗ error · ↳ fell back to another model · ⠋ running · ● brain notes · ◆ model calls · ▸ selected/folded — Tab chat · ^B behind the scenes · /review · /send <text> · /brain <spec>");
    } else void this.ask(t, selected);
    return true;
  }
}

export async function runWatch(args: WatchArgs): Promise<void> {
  if (!args.session) {
    console.error("✖ --session <claude session id> is required (or run `tachi-agent watch --open` from inside Claude Code).");
    process.exit(1);
  }
  const cwd = args.cwd ?? process.cwd();
  // the pane's tab shows "tachi-watch", not the long launch command
  process.stdout.write(`\x1b]0;tachi-watch · ${args.session.slice(0, 8)}\x07`);
  const controller = new WatchController({ ...args, session: args.session, cwd }, loadWatchConfig(cwd));
  controller.start();
  const { renderWatchUi } = await import("./ui.js");
  await renderWatchUi(controller);
  await controller.stop();
  process.exit(0);
}
