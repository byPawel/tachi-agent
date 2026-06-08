// src/swarm/synthesis.ts
import type { SwarmMember } from "./types.js";

/**
 * Assemble the synthesizer's prompt from the members' answers. Members with an
 * empty answer (errored/timed-out before producing one) are omitted.
 */
export function buildSynthesisPrompt(task: string, members: SwarmMember[]): string {
  const sections = members
    .filter((m) => m.answer.trim() !== "")
    .map((m) => `### ${m.role}\n${m.answer.trim()}`)
    .join("\n\n");
  return [
    `Synthesize ONE best answer to the task from the role perspectives below.`,
    `Resolve disagreements explicitly; keep what's correct, drop what the critic refutes.`,
    `If the council/router tools (tachibot_jury / tachibot_tachi) are available, use them to adjudicate.`,
    ``,
    `## Task`,
    task,
    ``,
    `## Perspectives`,
    sections,
    ``,
    `Return a single synthesized answer.`,
  ].join("\n");
}
