import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, findSkill, parseSkillFile } from "../skills.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "tachi-skills-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const GOOD = `---
name: researcher
description: grounded research
tools: tachibot_grok_search, tachibot_perplexity_ask
driver: openai
---
Always search before answering. Cite sources.`;

describe("parseSkillFile", () => {
  it("parses frontmatter and body", () => {
    const s = parseSkillFile(GOOD, "researcher.md");
    expect(s).toEqual({
      name: "researcher",
      description: "grounded research",
      tools: ["tachibot_grok_search", "tachibot_perplexity_ask"],
      driver: "openai",
      prompt: "Always search before answering. Cite sources.",
    });
  });
  it("returns null without a name (malformed)", () => {
    expect(parseSkillFile("---\ndescription: x\n---\nbody", "x.md")).toBeNull();
  });
  it("tools/driver optional; empty tools omitted", () => {
    const s = parseSkillFile("---\nname: minimal\n---\njust a prompt", "m.md");
    expect(s).toEqual({ name: "minimal", description: "", prompt: "just a prompt" });
  });
});

describe("loadSkills", () => {
  it("loads .md files from the dir, skipping malformed ones", async () => {
    await writeFile(join(dir, "researcher.md"), GOOD);
    await writeFile(join(dir, "broken.md"), "no frontmatter at all");
    await writeFile(join(dir, "notes.txt"), "ignored");
    const skills = await loadSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(["researcher"]);
  });
  it("missing dir → []", async () => {
    expect(await loadSkills(join(dir, "nope"))).toEqual([]);
  });
});

describe("findSkill", () => {
  it("finds by exact name, null otherwise", async () => {
    await writeFile(join(dir, "researcher.md"), GOOD);
    const skills = await loadSkills(dir);
    expect(findSkill(skills, "researcher")?.driver).toBe("openai");
    expect(findSkill(skills, "nope")).toBeNull();
  });
});
