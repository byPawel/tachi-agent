/**
 * Router layer — deterministic, minimal (per the 2026-06-04 council verdict).
 *
 * The local model can't be trusted to decide WHEN to search — it skipped search
 * and hallucinated a fake description of an unknown `.com`. So instead of a full
 * intent-classifier, we force one thing: a grounding SEARCH before the model
 * speaks about a named entity / URL. No LLM classifier, no jury-forcing — just
 * close the hallucination hole. Expand only if usage shows complex tool chaining.
 */

const DOMAIN = /\b[\w-]+\.(com|io|ai|org|net|dev|app|co|gg|sh)\b/i;
const WHAT_IS = /\b(what|who)\s+(is|are|was|were)\s+\S/i;
const ENTITY_ASK = /\b(tell me about|info(?:rmation)? on|details on|look up|search for)\b/i;

/**
 * True when the query names a specific entity/URL whose facts the model must NOT
 * invent — force a search first.
 */
export function needsGroundingSearch(query: string): boolean {
  return DOMAIN.test(query) || WHAT_IS.test(query) || ENTITY_ASK.test(query);
}
