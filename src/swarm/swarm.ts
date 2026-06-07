// src/swarm/swarm.ts
import type { SwarmRole, SwarmMember, SwarmResult, SwarmDeps } from "./types.js";
import { buildSynthesisPrompt } from "./synthesis.js";

/** The reserved role the synthesizer agent is built from. */
export const SYNTHESIZER_ROLE: SwarmRole = {
  name: "__synthesizer__",
  systemPrompt: "You are the SYNTHESIZER. Merge the role perspectives into one best answer; prefer correctness over consensus.",
};

export interface RunSwarmOptions {
  signal?: AbortSignal;
  /** Called as each member settles. */
  onMember?: (m: SwarmMember) => void;
  /** Max members running at once (default 4). Bounds fan-out for large role sets. */
  concurrency?: number;
  /** Min members that must produce a non-empty answer for a healthy swarm (default 2). */
  minQuorum?: number;
}

/**
 * Run each role on the SAME task with bounded concurrency, then synthesize.
 * PURE: every LLM-bound path goes through deps.makeAgent (mockable in tests).
 * Failures are tolerated — a member that throws is recorded with an empty answer
 * (haltedBy "aborted") and excluded from synthesis. Quorum shortfalls and missing
 * critical-role answers are reported as non-fatal warnings, never thrown.
 */
export async function runSwarm(
  task: string,
  roles: SwarmRole[],
  deps: SwarmDeps,
  opts: RunSwarmOptions = {},
): Promise<SwarmResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const members: SwarmMember[] = new Array(roles.length);

  // Bounded async pool: workers pull role indices until exhausted. Results land at
  // their role index so member order is preserved regardless of completion order.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < roles.length; i = next++) {
      const role = roles[i];
      let m: SwarmMember;
      try {
        const r = await deps.makeAgent(role).run(task, { signal: opts.signal });
        m = { role: role.name, answer: r.answer, haltedBy: r.haltedBy, costUsd: r.costUsd };
      } catch {
        m = { role: role.name, answer: "", haltedBy: "aborted", costUsd: 0 };
      }
      members[i] = m;
      opts.onMember?.(m);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, roles.length) }, () => worker()));

  // Quorum: warn (never throw) on too-few answers or a missing critical-role answer.
  const warnings: string[] = [];
  const minQuorum = opts.minQuorum ?? 2;
  const answered = members.filter((m) => m.answer.trim() !== "");
  if (answered.length < minQuorum) {
    warnings.push(`quorum: only ${answered.length}/${roles.length} member(s) produced an answer (min ${minQuorum}).`);
  }
  for (const role of roles.filter((r) => r.critical)) {
    const m = members.find((x) => x.role === role.name);
    if (!m || m.answer.trim() === "") warnings.push(`critical role "${role.name}" produced no answer.`);
  }

  const prompt = buildSynthesisPrompt(task, members);
  const synth = await deps.makeAgent(SYNTHESIZER_ROLE).run(prompt, { signal: opts.signal });
  return { answer: synth.answer, members, ...(warnings.length ? { warnings } : {}) };
}
