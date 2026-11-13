# Council: reliable PROMPTS catalog in the watch panel

**Query:** `/council zrob`, interpreted as: how should the tachi-agent watch panel's PROMPTS tab reliably show tachibot's 88-technique catalog in every project?

**Confidence:** Medium (evidence gate 0.25 caps it)

**Models:** Grok, Perplexity, Kimi, OpenAI, Gemini, Jev

**Fallbacks and failures:**
- One Grok research angle (mechanism) failed with `Connection closed`.
- The OpenAI risk step in the nextThought chain did not execute (`openai_reason` not available); Gemini covered the risks in step 4.

## Context

- The panel fetches `/techniques` from a per-process trace server. It needs `TACHIBOT_TRACE_UI=1`, starts on the first traced call, and tries 10 ports from 7717. 27 tachibot processes were live.
- The panel tries once and keeps `[]`, so a miss lasts until it is reopened.
- Importing tachibot's build is opt-in since `7ab1bbe`, because it runs repo code.
- `TACHIBOT_TRACE_UI=1` and `TACHIBOT_TRACE_OPEN=0` were set globally in `~/.claude.json` during this session.

## Research

- Static versioned catalogs beat per-session HTTP for mostly static metadata.
- Fixed port ranges and lockfiles fail repeatedly in other dev tools (Claude Code IDE, Jupyter, Spring Tools): stale locks and wrong liveness checks.
- If a port stays, port 0 with a token is better than a fixed range.

## Debate

- **For a startup `techniques.json`:** no flag or port dependency, and data only.
- **Against:** writers on different versions overwrite each other, staleness, no authentication, and the panel can still open before the file exists.
- **Synthesis:** bundled snapshot first, with port allocation handled separately as a tracing issue.
- **Outside note from the tachi-watch panel:** writers and schema compatibility need resolving before any file approach; retrying only on empty leaves a stale loaded catalog unchanged.

## Scores

| Option | Score /1000 |
|---|---|
| Bundled snapshot | 920 |
| Snapshot + live refresh | 900 |
| Startup file | 515 |
| Port 0 | 440 |
| Retry + env | 425 |
| Do nothing | 360 |

## Calibration (Jev)

- Evidence sufficiency: 0.25
- Pick: snapshot, p=0.91, confidence 0.89
- Risk: low (0.74)

## Resolution

The first gemini_judge verdict was snapshot plus a version-gated live upgrade. Jev dissented at p=0.91, so the resolver was asked again and reversed: pure snapshot, remove the live `/techniques` fetch from the panel. Reason: the catalog changes only on tachibot releases, and `/techniques` returns a bare array, so gating would need new work in both packages.

## Recommendation

1. Add a sync script that generates `techniques.snapshot.json` from the local tachibot catalog, with `schemaVersion` and `catalogVersion`.
2. Make `loadTechniques` read the bundled snapshot, drop the HTTP and local-build paths, and show the catalog version in the PROMPTS header.
3. Add a pre-publish check that fails if the snapshot differs from the tachibot catalog.

Port allocation for live tracing stays a separate issue in tachibot.

**Would change this:** techniques generated per project or by plugins at runtime, or a need for the panel to match each installed tachibot version exactly.

**Status:** decision only, nothing implemented.
