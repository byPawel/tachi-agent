/**
 * Skill bundles — reusable prompt + tool-allowlist + driver presets, loaded
 * from human-edited markdown files (default ".tachi/skills/*.md", override
 * TACHI_SKILLS_DIR). A skill narrows what one run sees: its body is appended
 * to the system prompt, `tools` filters the run's tool surface (fail-closed),
 * and `driver` suggests a heart (precedence: session/--driver > skill.driver
 * > TACHI_DRIVER — enforced by callers, documented in the spec).
 *
 * Frontmatter (--- delimited): name (required), description, tools
 * (comma-separated namespaced names), driver. Malformed files are skipped
 * with a stderr warn — same fail-soft contract as schedules.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  driver?: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** Parse one skill file. Returns null (caller warns) when malformed. */
export function parseSkillFile(raw: string, filename: string): Skill | null {
  const m = FRONTMATTER.exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!meta.name) return null;
  const tools = (meta.tools ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const skill: Skill = {
    name: meta.name,
    description: meta.description ?? "",
    prompt: m[2].trim(),
  };
  if (tools.length) skill.tools = tools;
  if (meta.driver) skill.driver = meta.driver;
  return skill;
}

/** All valid skills in the dir (default .tachi/skills, env TACHI_SKILLS_DIR). Missing dir → []. */
export async function loadSkills(dir?: string): Promise<Skill[]> {
  const root = dir ?? process.env.TACHI_SKILLS_DIR ?? join(".tachi", "skills");
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const skills: Skill[] = [];
  for (const n of names.filter((n) => n.endsWith(".md")).sort()) {
    const raw = await readFile(join(root, n), "utf8").catch(() => "");
    const skill = parseSkillFile(raw, n);
    if (skill) skills.push(skill);
    else console.error(`[skills] skipping malformed skill file: ${n}`);
  }
  return skills;
}

export function findSkill(skills: Skill[], name: string): Skill | null {
  return skills.find((s) => s.name === name) ?? null;
}
