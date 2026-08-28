/**
 * Tests for chat-commands.ts — unified chat-command layer.
 * TDD: written before the implementation.
 *
 * Uses a lines-collector pattern (mirrors cli-commands.test.ts style).
 * All side-effects are injected via ChatDeps.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  handleChatLine,
  resolveRunOptions,
  pushHistory,
  SESSION_HISTORY_MAX,
  CHAT_HELP,
  type ChatSession,
  type ChatDeps,
  type ChatAction,
} from "../chat-commands.js";
import type { Skill } from "../skills.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_RESEARCHER: Skill = {
  name: "researcher",
  description: "grounded research",
  prompt: "Always search before answering. Cite sources.",
  tools: ["tachibot_grok_search", "tachibot_perplexity_ask"],
  driver: "openai",
};

const SKILL_CODER: Skill = {
  name: "coder",
  description: "code assistant",
  prompt: "Write clean code.",
};

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return { ...overrides };
}

function makeDeps(
  sessionOverrides: Partial<ChatSession> = {},
  skillList: Skill[] = [SKILL_RESEARCHER, SKILL_CODER],
  depsOverrides: Partial<ChatDeps> = {},
): ChatDeps & { session: ChatSession } {
  const session: ChatSession = makeSession(sessionOverrides);
  return {
    session,
    skills: skillList,
    listTools: () => "tachibot_jury\ntachibot_grok_search",
    modelName: () => "claude-sonnet-4-6",
    mode: "local",
    taskAdd: null,
    taskList: null,
    taskShow: null,
    scheduleList: null,
    ...depsOverrides,
  };
}

async function handle(line: string, deps: ChatDeps): Promise<ChatAction> {
  return handleChatLine(line, deps);
}

// ---------------------------------------------------------------------------
// Plain text (non-command)
// ---------------------------------------------------------------------------
describe("plain text", () => {
  it("returns kind:message for non-/ input", async () => {
    const deps = makeDeps();
    const action = await handle("tell me a joke", deps);
    expect(action).toEqual({ kind: "message", text: "tell me a joke" });
  });

  it("trims whitespace from plain text", async () => {
    const deps = makeDeps();
    const action = await handle("  hello world  ", deps);
    expect(action).toEqual({ kind: "message", text: "hello world" });
  });

  it("empty line returns kind:reply with empty text", async () => {
    const deps = makeDeps();
    const action = await handle("  ", deps);
    expect(action.kind).toBe("reply");
  });
});

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------
describe("/help", () => {
  it("returns kind:reply with CHAT_HELP text", async () => {
    const deps = makeDeps();
    const action = await handle("/help", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toBe(CHAT_HELP);
  });

  it("CHAT_HELP mentions all major commands", () => {
    expect(CHAT_HELP).toContain("/tools");
    expect(CHAT_HELP).toContain("/model");
    expect(CHAT_HELP).toContain("/status");
    expect(CHAT_HELP).toContain("/driver");
    expect(CHAT_HELP).toContain("/skill");
    expect(CHAT_HELP).toContain("/reset");
    expect(CHAT_HELP).toContain("/jury");
    expect(CHAT_HELP).toContain("/search");
    expect(CHAT_HELP).toContain("/think");
    expect(CHAT_HELP).toContain("/task");
    expect(CHAT_HELP).toContain("/schedule");
    expect(CHAT_HELP).toContain("/exit");
  });
});

// ---------------------------------------------------------------------------
// /tools
// ---------------------------------------------------------------------------
describe("/tools", () => {
  it("returns kind:reply with listTools output", async () => {
    const deps = makeDeps();
    const action = await handle("/tools", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("tachibot_jury");
    expect(action.text).toContain("tachibot_grok_search");
  });
});

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------
describe("/model", () => {
  it("returns kind:reply with modelName output", async () => {
    const deps = makeDeps();
    const action = await handle("/model", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------
describe("/status", () => {
  it("includes mode in status output", async () => {
    const deps = makeDeps();
    const action = await handle("/status", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("local");
  });

  it("includes driver when set", async () => {
    const deps = makeDeps({ driver: "openai" });
    const action = await handle("/status", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("openai");
  });

  it("indicates no driver when unset", async () => {
    const deps = makeDeps();
    const action = await handle("/status", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    // Should mention driver section but without a specific name
    expect(action.text.toLowerCase()).toContain("driver");
  });

  it("includes skill name when set", async () => {
    const deps = makeDeps({ skill: SKILL_RESEARCHER });
    const action = await handle("/status", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("researcher");
  });
});

// ---------------------------------------------------------------------------
// /driver
// ---------------------------------------------------------------------------
describe("/driver", () => {
  it("sets the driver on the session and confirms", async () => {
    const deps = makeDeps();
    const action = await handle("/driver openai", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(deps.session.driver).toBe("openai");
    expect(action.text).toContain("openai");
  });

  it("/driver off clears the driver", async () => {
    const deps = makeDeps({ driver: "openai" });
    const action = await handle("/driver off", deps);
    expect(action.kind).toBe("reply");
    expect(deps.session.driver).toBeUndefined();
  });

  it("requires an argument", async () => {
    const deps = makeDeps();
    const action = await handle("/driver", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text.toLowerCase()).toContain("usage");
  });
});

// ---------------------------------------------------------------------------
// /skill
// ---------------------------------------------------------------------------
describe("/skill", () => {
  it("sets a known skill on the session and confirms", async () => {
    const deps = makeDeps();
    const action = await handle("/skill researcher", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(deps.session.skill?.name).toBe("researcher");
    expect(action.text).toContain("researcher");
  });

  it("/skill off clears the skill", async () => {
    const deps = makeDeps({ skill: SKILL_RESEARCHER });
    const action = await handle("/skill off", deps);
    expect(action.kind).toBe("reply");
    expect(deps.session.skill).toBeUndefined();
  });

  it("unknown skill replies with available list", async () => {
    const deps = makeDeps();
    const action = await handle("/skill nope", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("researcher");
    expect(action.text).toContain("coder");
  });

  it("no available skills replies gracefully", async () => {
    const deps = makeDeps({}, []);
    const action = await handle("/skill anything", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    // Should say no skills are available
    expect(action.text.toLowerCase()).toMatch(/no skills|unavailable|not found/);
  });

  it("requires an argument", async () => {
    const deps = makeDeps();
    const action = await handle("/skill", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text.toLowerCase()).toContain("usage");
  });
});

// ---------------------------------------------------------------------------
// /reset
// ---------------------------------------------------------------------------
describe("/reset", () => {
  it("clears driver, skill AND history on the session and confirms", async () => {
    const deps = makeDeps({
      driver: "openai",
      skill: SKILL_RESEARCHER,
      history: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    });
    const action = await handle("/reset", deps);
    expect(action.kind).toBe("reply");
    expect(deps.session.driver).toBeUndefined();
    expect(deps.session.skill).toBeUndefined();
    expect(deps.session.history).toBeUndefined();
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text.toLowerCase()).toContain("reset");
  });
});

// ---------------------------------------------------------------------------
// Conversation history (chat continuity)
// ---------------------------------------------------------------------------
describe("pushHistory", () => {
  it("appends one user+assistant exchange", () => {
    const session = makeSession();
    pushHistory(session, "who created Linux?", "Linus Torvalds.");
    expect(session.history).toEqual([
      { role: "user", content: "who created Linux?" },
      { role: "assistant", content: "Linus Torvalds." },
    ]);
  });

  it("skips empty answers and [halted:…] placeholders", () => {
    const session = makeSession();
    pushHistory(session, "task", "");
    pushHistory(session, "task", "   ");
    pushHistory(session, "task", "[halted: timeout, no final answer produced]");
    expect(session.history).toBeUndefined();
  });

  it("caps the rolling window at SESSION_HISTORY_MAX, dropping the oldest", () => {
    const session = makeSession();
    for (let i = 0; i < SESSION_HISTORY_MAX; i++) pushHistory(session, `q${i}`, `a${i}`);
    expect(session.history).toHaveLength(SESSION_HISTORY_MAX);
    expect(session.history![0].content).toBe(`q${SESSION_HISTORY_MAX / 2}`);
    expect(session.history![SESSION_HISTORY_MAX - 1].content).toBe(`a${SESSION_HISTORY_MAX - 1}`);
  });
});

describe("resolveRunOptions history pass-through", () => {
  it("includes session.history when present", () => {
    const history = [
      { role: "user" as const, content: "q" },
      { role: "assistant" as const, content: "a" },
    ];
    expect(resolveRunOptions(makeSession({ history }))).toEqual({ history });
  });

  it("omits history when the session has none (default path unchanged)", () => {
    expect(resolveRunOptions(makeSession())).toEqual({});
    expect(resolveRunOptions(makeSession({ history: [] }))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// /jury, /search, /think — rewrite to agent tasks
// ---------------------------------------------------------------------------
describe("/jury", () => {
  it("rewrites to kind:run with exact jury phrasing", async () => {
    const deps = makeDeps();
    const action = await handle("/jury is TypeScript worth it?", deps);
    expect(action.kind).toBe("run");
    if (action.kind !== "run") throw new Error("narrowing");
    expect(action.text).toBe(
      "Use tachibot_jury to deliver a cross-model verdict on: is TypeScript worth it?",
    );
  });

  it("requires a query", async () => {
    const deps = makeDeps();
    const action = await handle("/jury", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text.toLowerCase()).toContain("usage");
  });
});

describe("/search", () => {
  it("rewrites to kind:run with exact search phrasing", async () => {
    const deps = makeDeps();
    const action = await handle("/search latest Node.js LTS", deps);
    expect(action.kind).toBe("run");
    if (action.kind !== "run") throw new Error("narrowing");
    expect(action.text).toBe(
      "Use tachibot_grok_search (or perplexity) to look up: latest Node.js LTS",
    );
  });

  it("requires a query", async () => {
    const deps = makeDeps();
    const action = await handle("/search", deps);
    expect(action.kind).toBe("reply");
  });
});

describe("/think", () => {
  it("rewrites to kind:run with exact think phrasing", async () => {
    const deps = makeDeps();
    const action = await handle("/think why is the sky blue?", deps);
    expect(action.kind).toBe("run");
    if (action.kind !== "run") throw new Error("narrowing");
    expect(action.text).toBe("Reason carefully step by step: why is the sky blue?");
  });

  it("requires a query", async () => {
    const deps = makeDeps();
    const action = await handle("/think", deps);
    expect(action.kind).toBe("reply");
  });
});

// ---------------------------------------------------------------------------
// /task subcommands
// ---------------------------------------------------------------------------
describe("/task", () => {
  it("/task list returns daemon-hint when taskList is null", async () => {
    const deps = makeDeps({}, [], { taskList: null });
    const action = await handle("/task list", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("TACHI_DAEMON_URL");
    expect(action.text).toContain("GATEWAY_TOKEN");
  });

  it("/task list invokes taskList when bound", async () => {
    const deps = makeDeps({}, [], {
      taskList: async () => "id-1  queued  attempt 0/3  default  my task",
    });
    const action = await handle("/task list", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("id-1");
  });

  it("/task add queues a task when bound", async () => {
    const captured: Array<{ text: string; opts: { driver?: string } }> = [];
    const deps = makeDeps({}, [], {
      taskAdd: async (text, opts) => {
        captured.push({ text, opts });
        return "queued tid-001";
      },
    });
    const action = await handle("/task add write unit tests", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(captured[0].text).toBe("write unit tests");
    expect(action.text).toContain("queued tid-001");
  });

  it("/task add uses session driver when set", async () => {
    const captured: Array<{ text: string; opts: { driver?: string } }> = [];
    const deps = makeDeps({ driver: "openai" }, [], {
      taskAdd: async (text, opts) => {
        captured.push({ text, opts });
        return "queued tid-002";
      },
    });
    await handle("/task add write tests", deps);
    expect(captured[0].opts.driver).toBe("openai");
  });

  it("/task add returns daemon-hint when taskAdd is null", async () => {
    const deps = makeDeps({}, [], { taskAdd: null });
    const action = await handle("/task add something", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("TACHI_DAEMON_URL");
  });

  it("/task show returns daemon-hint when taskShow is null", async () => {
    const deps = makeDeps({}, [], { taskShow: null });
    const action = await handle("/task show abc-123", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("TACHI_DAEMON_URL");
  });

  it("/task show invokes taskShow when bound", async () => {
    const deps = makeDeps({}, [], {
      taskShow: async (id) => `{ "id": "${id}", "status": "done" }`,
    });
    const action = await handle("/task show abc-123", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("abc-123");
  });

  it("/task with unknown subcommand returns usage hint", async () => {
    const deps = makeDeps();
    const action = await handle("/task unknown", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text.toLowerCase()).toContain("usage");
  });

  it("/task alone (no subcommand) returns usage hint", async () => {
    const deps = makeDeps();
    const action = await handle("/task", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text.toLowerCase()).toContain("usage");
  });
});

// ---------------------------------------------------------------------------
// /schedule subcommands
// ---------------------------------------------------------------------------
describe("/schedule", () => {
  it("/schedule list returns daemon-hint when scheduleList is null", async () => {
    const deps = makeDeps({}, [], { scheduleList: null });
    const action = await handle("/schedule list", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("TACHI_DAEMON_URL");
    expect(action.text).toContain("GATEWAY_TOKEN");
  });

  it("/schedule list invokes scheduleList when bound", async () => {
    const deps = makeDeps({}, [], {
      scheduleList: async () => "sched-1  daily  my schedule",
    });
    const action = await handle("/schedule list", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("sched-1");
  });
});

// ---------------------------------------------------------------------------
// /exit and /quit
// ---------------------------------------------------------------------------
describe("/exit and /quit", () => {
  it("/exit returns kind:exit", async () => {
    const deps = makeDeps();
    const action = await handle("/exit", deps);
    expect(action).toEqual({ kind: "exit" });
  });

  it("/quit returns kind:exit", async () => {
    const deps = makeDeps();
    const action = await handle("/quit", deps);
    expect(action).toEqual({ kind: "exit" });
  });
});

// ---------------------------------------------------------------------------
// Unknown /commands
// ---------------------------------------------------------------------------
describe("unknown commands", () => {
  it("unknown /cmd returns kind:reply with try /help hint", async () => {
    const deps = makeDeps();
    const action = await handle("/foobar", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("/help");
    expect(action.text.toLowerCase()).toMatch(/unknown|unrecognized/);
  });

  it("includes the unknown command name in the hint", async () => {
    const deps = makeDeps();
    const action = await handle("/bogus-cmd", deps);
    expect(action.kind).toBe("reply");
    if (action.kind !== "reply") throw new Error("narrowing");
    expect(action.text).toContain("/bogus-cmd");
  });
});

// ---------------------------------------------------------------------------
// resolveRunOptions
// ---------------------------------------------------------------------------
describe("resolveRunOptions", () => {
  it("session driver only → driver returned, no skill fields", () => {
    const session: ChatSession = { driver: "openai" };
    const opts = resolveRunOptions(session);
    expect(opts.driver).toBe("openai");
    expect(opts.systemPrompt).toBeUndefined();
    expect(opts.allowTools).toBeUndefined();
  });

  it("skill only (driver from skill) → returns skill.driver, prompt, tools", () => {
    const session: ChatSession = { skill: SKILL_RESEARCHER };
    const opts = resolveRunOptions(session);
    expect(opts.driver).toBe("openai"); // from skill
    expect(opts.systemPrompt).toBe(SKILL_RESEARCHER.prompt);
    expect(opts.allowTools).toEqual(SKILL_RESEARCHER.tools);
  });

  it("both session.driver and skill.driver → session.driver wins", () => {
    const session: ChatSession = { driver: "anthropic", skill: SKILL_RESEARCHER };
    const opts = resolveRunOptions(session);
    expect(opts.driver).toBe("anthropic"); // session wins over skill's "openai"
    expect(opts.systemPrompt).toBe(SKILL_RESEARCHER.prompt); // skill prompt still applies
    expect(opts.allowTools).toEqual(SKILL_RESEARCHER.tools);
  });

  it("neither driver nor skill → empty result", () => {
    const session: ChatSession = {};
    const opts = resolveRunOptions(session);
    expect(opts.driver).toBeUndefined();
    expect(opts.systemPrompt).toBeUndefined();
    expect(opts.allowTools).toBeUndefined();
  });

  it("skill without driver and no session driver → driver undefined", () => {
    const session: ChatSession = { skill: SKILL_CODER };
    const opts = resolveRunOptions(session);
    expect(opts.driver).toBeUndefined(); // SKILL_CODER has no driver
    expect(opts.systemPrompt).toBe(SKILL_CODER.prompt);
    expect(opts.allowTools).toBeUndefined(); // SKILL_CODER has no tools
  });
});
