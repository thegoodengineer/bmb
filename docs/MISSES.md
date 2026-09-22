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

## Public rounds, 2026-09-22 (Groq free tier: gpt-oss-120b, falling back to gpt-oss-20b / qwen3.8-27b)

### F05 Renamed · H2 · gpt-oss-20b · round 7c86add9: workaround instead of repair

- **Outcome:** unhealed (provider rate limit ended the round), later marked invalid by a referee restart; judge not run
- **What the healer did:** read the columns, saw `content` where the app reads `body`, then added `body text GENERATED ALWAYS AS (content) STORED`, dropped it, and added a plain `body text` column
- **What was actually wrong:** column `body` was renamed to `content`; the fix is `ALTER TABLE notes RENAME COLUMN content TO body`
- **What it exposed in the referee:** the F05 artifact check only asked "does `body` exist", so a new column beside `content` read as fixed; and the reset crashed on the duplicate column, taking the referee down until it was changed to drop a healer-added `body` before renaming back. The check now treats `content` still existing as the fault still present.
- **Upstream:** none; referee bug, fixed in this repo

### F06 Poison Pill · H2 · gpt-oss-20b · round 9b42e9a0: wrong component

- **Outcome:** unhealed, judge 4/9 fail (round later reclassified invalid because it ended on a malformed tool call)
- **What the healer diagnosed:** `notes_insert_own` policy, "INSERT withCheck requires owner_id but client omits it"
- **What was actually wrong:** a `BEFORE INSERT` trigger `notes_block` raising `nope` (the probe error text was `P0001 nope`)
- **What happened:** the healer never called `db_triggers`; it tried to add an owner-setting trigger, which the old SQL filter wrongly refused as two statements (function bodies contain `;`). The filter now parses dollar-quoted bodies.

### C01 Double Lock · H2 · gpt-oss-120b · round 6e2f92b0: stopped after one of two faults

- **Outcome:** the healer fixed the deny-all select policy with `ALTER POLICY`, probes stayed red because `SELECT` was also revoked; the round then hung on a provider request for 12 minutes and was invalidated by a restart
- **What was actually wrong:** select policy `USING (false)` **and** `REVOKE SELECT ON notes FROM authenticated`
- **What it exposed:** model calls had no per-request timeout and the wall clock was only checked between turns; both fixed

### F07 Vanished RPC · H2 · gpt-oss-120b, then gpt-oss-20b · round c537222f: believed a refused write had run

- **Outcome:** unhealed (`gave_up` after 9 tool calls, about 3 minutes); judge 9/9 pass, time to diagnosis 59 s
- **What the healer diagnosed:** `public.note_count` function, "missing function definition in public schema" (correct)
- **What was actually wrong:** `note_count()` was dropped; the fix is to recreate it as a security-invoker SQL function counting the caller's notes
- **What happened:** after four read calls on `gpt-oss-120b`, the chain fell back to `gpt-oss-20b`. Its first action was `CREATE OR REPLACE FUNCTION public.note_count() …` before `submit_diagnosis`, which the gate refused. It then submitted a correct diagnosis and from that point reasoned as if the function existed ("We added function"), even after `db_functions` and a `pg_proc` query both showed it missing. Its last turn was the sentence "Let's run probe." with no tool call, which the runner read as the end of the run. The refused statement would also have failed on its own, because it filtered on `user_id` while the column is `owner_id`.
- **What changed in the referee:** the `submit_diagnosis` result now states how many write calls were refused before it and that nothing has run. A turn with no tool call now gets one neutral prompt ("nothing ran; reply DONE or make the next call"). The referee sends it without consulting the oracle, so it reveals nothing about the victim. The run ends only on the second such turn.
- **Upstream:** none

### F08 Impossible Rule · H2 · gpt-oss-20b · self-play round c3bc6582: a correct repair scored as unhealed (referee bug)

- **Outcome as recorded:** unhealed (`artifact_present`) with judge 9/9 pass. **Reclassified** as healed, with time to mitigation 111 s.
- **What the healer did:** read the constraint with `pg_get_constraintdef`, diagnosed the inverted `CHECK (length(title) < 1)`, dropped it and re-added `notes_title_impossible CHECK (length(title) > 0)` under the same name. All six probes stayed green for 12 cycles.
- **What it exposed in the referee:** the F08 artifact check treated *any* CHECK constraint on `notes` as the fault, so a sane replacement read as the fault still present. The check now matches the injected rule itself (a title shorter than one character) under any name. The reset drops every CHECK constraint on `notes`, since the baseline has none. The integration suite replays this repair.
- **Upstream:** none; referee bug, fixed in this repo

### F06 Poison Pill · H2 · gpt-oss-120b, then gpt-oss-20b · self-play round 499c6a31: lost the thread after a model fallback

- **Outcome as recorded:** invalid (`provider_error: deadline after 35506ms`). **Reclassified** as unhealed (`budget_time`), with judge 0/9 because no diagnosis was submitted.
- **What happened:** `gpt-oss-120b` called `db_triggers` and received `notes_block` (a `BEFORE INSERT` trigger calling `bmb_block()`). On the next turn the chain fell back to `gpt-oss-20b`, which returned to the insert policy and looped for eight minutes over `db_policies` (four calls), the column list (three calls) and the logs (five calls). It never submitted a diagnosis.
- **What it exposed in the referee:** the last model call hit a request-too-large error, and its retry ran into the round's wall clock. A deadline inside that retry was reported as a provider error, which marks a round invalid. It is now a time-budget stop like any other deadline.
- **Upstream:** none
