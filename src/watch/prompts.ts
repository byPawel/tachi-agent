/**
 * tachi-watch — the PROMPTS tab: tachibot's prompt-technique catalog (88 research-backed
 * techniques), searchable, with a one-key way to ask Claude to apply one. The catalog
 * ships with the panel as a snapshot, so the tab works in any project whether or not
 * tachibot is running. It changes only on tachibot releases:
 * `node scripts/sync-techniques.mjs` refreshes it, and publishing fails if it has drifted.
 */
import snapshot from "./techniques.snapshot.json" with { type: "json" };

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

/** The bundled catalog; `from` names the tachibot version it came from, shown in the tab's header. */
export function loadTechniques(): { list: Technique[]; from: string } {
  return { list: snapshot.techniques as Technique[], from: `tachibot ${snapshot.catalogVersion} catalog` };
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
