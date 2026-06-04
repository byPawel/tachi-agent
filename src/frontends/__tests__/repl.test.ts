import { describe, it, expect } from "vitest";
import { parseCommand } from "../repl.js";

describe("REPL parseCommand", () => {
  it("treats blank input as empty", () => {
    expect(parseCommand("   ").kind).toBe("empty");
    expect(parseCommand("").kind).toBe("empty");
  });
  it("recognizes /exit and /quit", () => {
    expect(parseCommand("/exit").kind).toBe("exit");
    expect(parseCommand("  /quit ").kind).toBe("exit");
  });
  it("recognizes /help, /tools, /model", () => {
    expect(parseCommand("/help").kind).toBe("help");
    expect(parseCommand("/tools").kind).toBe("tools");
    expect(parseCommand("/model").kind).toBe("model");
  });
  it("treats anything else as a run with trimmed text", () => {
    const c = parseCommand("  what is a jury?  ");
    expect(c.kind).toBe("run");
    expect(c.kind === "run" && c.text).toBe("what is a jury?");
  });
});
