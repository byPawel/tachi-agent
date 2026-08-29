# Council: tachi-agent v0.3.0 distribution strategy

**Query:** npm publish vs Homebrew formula/tap vs both vs neither (git + npm link), for a Node>=20 CLI + daemon, 8 binaries, solo maintainer, Ollama-user audience (macOS-heavy).

**Pipeline:** Research (grok_search + perplexity_ask) → Adversarial debate (grok FOR / kimi AGAINST / GPT-5.x synthesis; focus-tool session scaffold fell back to parallel calls) → 3-thought reasoning chain (grok criteria → kimi risks → gemini verdict + final judge).

## Research highlights
- npm is canonical/near-zero burden for Node CLIs; Claude Code + Codex CLI are npm-primary precedent for this exact audience.
- Personal Homebrew tap = per-release formula bump (version + SHA); sustainable only with CI automation.
- aider's maintainers recommend AGAINST their own brew formula (version lag) — cautionary example of a second channel rotting.

## Debate
- FOR npm-only: instant releases, audience already npm-literate, tap at 0.3.x velocity ships stale code and becomes an unstaffable second support surface.
- AGAINST npm-only: npm has no service-lifecycle story (launchd plists pointing at nvm node paths rot), sudo/EACCES friction, brew-first discoverability among macOS users.
- Resolution of the tension: capture brew's daemon value WITHOUT a tap via a future `tachi-agent service install` command that generates the LaunchAgent from the CLI.

## Decision criteria (weighted)
Maintenance burden 40% · audience fit/discoverability 25% · daemon lifecycle 20% · update velocity under churn 15% → **npm-only scores highest**.

## Verdict (confidence: High)
**Publish to npm now (quietly), announce loudly later. No Homebrew tap at 0.3.x.**
1. Publish the real v0.3.0 to npm immediately — claims the free name (anti-squatting), no marketing push yet.
2. Bridge the daemon gap: manual launchd plist template in README until `tachi-agent service install` ships.
3. Build `tachi-agent service install` / `service uninstall` (MUST write the absolute node binary path into the plist — nvm/volta hide node from launchd's PATH); then announce publicly.

**Pinning guidance correction (from final judge):** for global installs use `npm install -g tachi-agent@0.3.0` — `--save-exact` only applies to local package.json.

**Brew tap trigger conditions (add later only when ALL hold):** real repeated demand for `brew install` · one-command release automation exists (formula URL+SHA bump in CI) · daemon lifecycle commands are stable · willingness to support it as official.

**What would flip the decision:** mass npm refusal from the audience; a community volunteer maintaining the tap; `service install` proving unviable.

## Models
grok (search, FOR-case, criteria), perplexity (research), kimi (AGAINST-case, risks), GPT-5.x (synthesis), gemini (verdict + final judge). Fallbacks: perplexity_research unavailable → grok_search + perplexity_ask; focus debate → parallel reason calls.
