/**
 * tachi-watch — the PROMPTS tab: tachibot's prompt-technique catalog (88 research-backed
 * techniques), searchable, with a one-key way to ask Claude to apply one. The catalog
 * comes from the running tachibot's trace server (/techniques, token-protected), else
 * from tachibot's build in the project (`dist/src/tools/prompt-technique-tools.js`).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface Technique {
  name: string;
  alias: string | null;
  description: string;
  useWhen: string;
  example: string;
  category: string;
  tier?: "core" | "advanced";
  kind?: "contract" | "scaffold" | "lens";
}

function getJson(url: string, timeoutMs = 4000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

const isList = (v: unknown): v is Technique[] => Array.isArray(v) && v.every((t) => t && typeof t.name === "string" && typeof t.category === "string");

/** The catalog: from the trace server when tachibot runs traced, else from tachibot's build in `cwd`. */
export async function loadTechniques(cwd: string, trace?: { port: number; token: string }): Promise<{ list: Technique[]; from: string }> {
  if (trace) {
    try {
      const v = await getJson(`http://127.0.0.1:${trace.port}/techniques?t=${encodeURIComponent(trace.token)}`);
      if (isList(v)) return { list: v, from: "tachibot (live)" };
    } catch {
      // older tachibot without /techniques, or not reachable — try the build
    }
  }
  // importing the project's build runs code from the repo — only when the user opts in
  const mod = path.join(cwd, "dist", "src", "tools", "prompt-technique-tools.js");
  if (process.env.TACHI_WATCH_LOCAL_TECHNIQUES === "1" && fs.existsSync(mod)) {
    const m = (await import(pathToFileURL(mod).href)) as { FLAT_TECHNIQUES?: unknown };
    if (isList(m.FLAT_TECHNIQUES)) return { list: m.FLAT_TECHNIQUES, from: "tachibot build" };
  }
  throw new Error("no technique catalog — run tachibot with TACHIBOT_TRACE_UI=1 (or set TACHI_WATCH_LOCAL_TECHNIQUES=1 in the tachibot-mcp project)");
}

/** Rank for a free-text task: name/alias hits weigh most, then "use when", then the description; core first on ties. */
export function rankTechniques(list: Technique[], query: string): Technique[] {
  const STOP = new Set(["and", "the", "for", "with", "that", "this", "you", "are", "how", "what", "can", "use", "into", "from", "when", "your", "our", "but", "not", "all", "any"]);
  const words = query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length) {
    return [...list].sort((a, b) => a.category.localeCompare(b.category) || Number(b.tier === "core") - Number(a.tier === "core") || a.name.localeCompare(b.name));
  }
  const score = (t: Technique) => {
    let s = 0;
    const name = `${t.name} ${t.alias ?? ""} ${t.category}`.toLowerCase();
    const when = t.useWhen.toLowerCase();
    const desc = t.description.toLowerCase();
    for (const w of words) {
      if (name.includes(w)) s += 3;
      if (when.includes(w)) s += 2;
      if (desc.includes(w)) s += 1;
    }
    return s + (s && t.tier === "core" ? 0.5 : 0);
  };
  return list
    .map((t) => [t, score(t)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name))
    .map(([t]) => t);
}

/** What Claude receives: apply this technique, through tachibot's preview → execute flow. */
export function techniqueMessage(t: Technique, task: string): string {
  const what = task.trim() || "the task we are on right now";
  return `Use tachibot's "${t.name}" prompt technique (${t.description.replace(/\s*\(arXiv:[^)]*\)/, "")}) on: ${what}. Run preview_prompt_technique with technique "${t.name}" and the right tool, then execute_prompt_technique with token "last".`;
}
