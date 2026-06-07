// src/swarm/swarm.ts
import type { SwarmRole, SwarmMember, SwarmResult, SwarmDeps, SwarmAgent } from "./types.js";
import { buildSynthesisPrompt } from "./synthesis.js";
import type { ToolHost } from "../types.js";
import { createOrchestrator, getDriver } from "../index.js";
import { buildAgentFromEnv } from "../runtime.js";
import { DokoroMemory } from "../memory/dokoro.js";
import { parseRoles } from "./roles.js";
import { randomUUID } from "node:crypto";

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
  roles.forEach((role, i) => {
    if (role.critical && members[i].answer.trim() === "") {
      warnings.push(`critical role "${role.name}" produced no answer.`);
    }
  });

  const prompt = buildSynthesisPrompt(task, members);
  const synth = await deps.makeAgent(SYNTHESIZER_ROLE).run(prompt, { signal: opts.signal });
  return { answer: synth.answer, members, ...(warnings.length ? { warnings } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O layer — default factory + env builder. Verified by typecheck/build (mirrors
// telegram.ts / daemon bins). `runSwarm` above stays pure; memory + traceId wiring
// live ONLY here.
// ─────────────────────────────────────────────────────────────────────────────

/** Session id for a member's isolated scratchpad. Unique per run via traceId → no cross-run recall. */
export const memberSessionId = (traceId: string, role: string): string => `swarm:${traceId}:${role}`;
/** Session id under which the swarm's final synthesized result is logged once. */
export const swarmTraceSession = (traceId: string): string => `swarm:${traceId}`;

/**
 * Default agent factory: a fresh Orchestrator per role over a SHARED ToolHost,
 * with the role's driver (or the swarm default) and the role lens as systemPrompt.
 * Each non-synthesizer member gets its OWN dokoro session (memberSessionId) so
 * members are isolated scratchpads — they cannot read peers, and the unique
 * per-run traceId means no cross-run recall. The synthesizer runs memory-less;
 * buildSwarmFromEnv logs the final result once under swarmTraceSession.
 */
export function defaultMakeAgent(host: ToolHost, defaultDriverName: string, traceId: string) {
  return (role: SwarmRole): SwarmAgent => {
    const driver = role.driver ? getDriver(role.driver) : getDriver(defaultDriverName);
    const memory =
      role.name === SYNTHESIZER_ROLE.name
        ? undefined
        : new DokoroMemory(host, { sessionId: memberSessionId(traceId, role.name), aiModel: driver.name });
    return {
      run: (task, o) =>
        createOrchestrator({
          driver,
          host,
          memory,
          options: { systemPrompt: role.systemPrompt, onEvent: o.onEvent, signal: o.signal },
        }).run(task),
    };
  };
}

/**
 * Build a ready-to-run swarm from env: roles from TACHI_SWARM_ROLES, a shared host
 * from buildAgentFromEnv, a unique traceId (injectable for tests), and a race-free
 * final log of the synthesized result under swarmTraceSession.
 */
export async function buildSwarmFromEnv(
  opts: { traceId?: string } = {},
): Promise<{
  run: (task: string, runOpts?: RunSwarmOptions) => Promise<SwarmResult>;
  roles: SwarmRole[];
  traceId: string;
  close: () => Promise<void>;
}> {
  const rt = await buildAgentFromEnv();
  const roles = parseRoles(process.env.TACHI_SWARM_ROLES);
  const traceId = opts.traceId ?? randomUUID();
  const makeAgent = defaultMakeAgent(rt.host, rt.driver.name, traceId);
  const finalMemory = new DokoroMemory(rt.host, { sessionId: swarmTraceSession(traceId), aiModel: rt.driver.name });
  return {
    roles,
    traceId,
    run: async (task, runOpts) => {
      const out = await runSwarm(task, roles, { makeAgent }, runOpts);
      await finalMemory.log({ task, result: out.answer }); // once, race-free
      return out;
    },
    close: () => rt.close(),
  };
}
