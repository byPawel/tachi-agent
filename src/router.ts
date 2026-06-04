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

/**
 * Decision/architecture intents the WEAK local planner must not answer alone.
 * Force a multi-model council consult (tachibot_tachi → architect/judge) instead.
 * Deterministic patterns only — no LLM classifier (mirrors needsGroundingSearch).
 */
const COMPARE = /\b(compare|versus|vs\.?|trade-?offs?|pros and cons|better than)\b/i;
// `should (i|we|you)` — "should we use X" is the most natural team framing of an
// engineering decision and is exactly what the council is for (was a false-negative
// when limited to "should i"). The `which …` branch is anchored to a comparative
// verdict word (better/best/right/preferable) so generic chat like "which color is
// nicer", "which one is correct", or "which file should I open" does NOT route to a
// cost-bearing consult.
const DECISION =
  /\bshould (?:i|we|you) (?:use|pick|choose|go with)\b|\bwhich (?:\w+ )?(?:is|are|should) (?:better|best|right|preferable|the right|the best)\b/i;
// `design` is anchored to an article + an architecture-ish noun so it does NOT fire on
// generation tasks ("design a function/logo") or incidental mentions ("the design is
// nice", "this design works") — those contradict this router's no-generation intent.
const ARCHITECT =
  /\b(?:architect(?:ure)?|design (?:the|a|an) (?:system|service|schema|api|db|database|auth|architecture|infra(?:structure)?|pipeline|data ?model|module)|best (?:approach|way|option|choice|stack|design))\b/i;

/**
 * True when the query is a comparison / tradeoff / architecture / design decision —
 * route it to the council (tachibot_tachi) rather than the local model's priors.
 */
export function needsCouncil(query: string): boolean {
  return COMPARE.test(query) || DECISION.test(query) || ARCHITECT.test(query);
}
