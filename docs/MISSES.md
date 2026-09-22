# Misses

Every round where the healer failed to heal or the judge failed the diagnosis. The referee appends an entry automatically (`apps/referee/src/misses.ts`); entries are edited by hand before publishing. Tone: neutral, reproducible, never a gotcha.

Entry template:

- **Outcome:** healed / unhealed (reason); judge score
- **What `diagnose --ai` said:** the platform debug agent's suggestion, verbatim where useful
- **What the healer diagnosed:** component and mechanism it submitted
- **What was actually wrong:** the ground truth from `FAULT_CATALOG.md`
- **What fixed it:** the statement or deploy that repaired it (or the reference fix at reset)
- **Judge evidence:** one line per question
- **Upstream:** link to the issue or PR filed against `insforge/agent-skills` or `insforge/insforge`, if any

## Platform behaviours found while building (not healer misses)

These were hit by the referee, not the healer, and are recorded in `INSFORGE_NOTES.md` with evidence:

- `functions deploy` intermittently returns `{"error":"Function deployment failed"}` with no build logs for a few minutes at a time; the same source deploys fine afterwards. The referee retries with backoff (10/20/40/60/60 s).
- A module-level `throw` in an edge function fails the *deployment* on Deno Subhosting rather than producing a broken-but-deployed function. A fault that "throws on invoke" must throw inside the handler.
- The first PostgREST request after any DDL on a table pays a schema-cache reload (~1.5 s from us-east to a client in India). A latency probe needs one retry to avoid a false positive.
- The local Docker runtime executes only CommonJS (`module.exports`) edge functions, while the cloud runtime and the documentation use ESM. `docs/INSFORGE_NOTES.md` §B has the four-variant experiment.
