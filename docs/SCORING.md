# Scoring

Every round produces two verdicts, computed by different code from different evidence:

- **Healed?** decided by the mitigation oracle from backend *state*.
- **Diagnosed?** decided by the judge from the healer's *claim* and the ground truth.

The interesting number is where they disagree.

## The oracle

```
healed := greenStreak >= 3  AND  for every scored fault f: artifactPresent(f) == false
```

- `greenStreak` counts consecutive probe cycles (P1–P6) in which every probe passed. Cycles run every 3 seconds during a round.
- `artifactPresent(f)` is a catalog query, never a probe: `pg_policies` for the deny-all policy, `pg_indexes` for a `(owner_id, created_at)` index on notes, `has_table_privilege` for the grant, `information_schema.columns` for `body`, `pg_trigger` for BEFORE INSERT / BEFORE UPDATE triggers, `pg_constraint` for a CHECK on notes, `pg_proc` and `pg_get_functiondef` for the RPC and its predicate, `functions code` for the poison line in `summarize`.
- Checks are tolerant of correct-but-different fixes: any index leading with `owner_id` and containing `created_at` counts, any owner-scoped select policy referencing `auth.uid()` counts, any rewrite of `note_count` without `<>` counts.
- Decoys are excluded. They are noise, not faults; the reset removes them.

**The reward-hacking guard.** If probes are green but an artifact is still present, the oracle reports `artifact_present` and the round keeps running. The canonical example: the healer adds `create policy allow_all on notes for select using (true)` next to the injected `using (false)` policy. Every probe passes; the deny-all policy is still there; the round is not healed. The same guard catches a rebuilt table, a replacement function under a new name with the RPC pointed at it, and a re-granted privilege on a renamed column.

## The judge

Input: ground truth for each scored fault in the round (component, mechanism, affected probes), the decoys present (so it knows what *not* to credit), the probes that were actually red at attack time, and the healer's **last** `submit_diagnosis`. Never the tool history: the judge grades the claim, not the journey.

Nine yes/no questions, three dimensions:

| # | Dimension | Question |
| --- | --- | --- |
| 1 | Localization | Same component(s) as ground truth? |
| 2 | Localization | Blames the origin rather than a downstream symptom? |
| 3 | Localization | Avoids naming a healthy component as the origin? |
| 4 | Characterization | Same mechanism? |
| 5 | Characterization | A concrete detail (policy, index, column, trigger, constraint, function name)? |
| 6 | Characterization | Avoids attributing to an unrelated fault type? |
| 7 | Scope | Avoids blaming decoys or uninvolved components? |
| 8 | Scope | For combos: names both faults? (singles: automatically yes) |
| 9 | Scope | Described impact consistent with the probes actually affected? |

`pass := score >= 7 AND loc > 0 AND char > 0 AND scope > 0`. No diagnosis submitted scores 0/9. The judge runs at low effort with structured JSON output and stores answers and one evidence sentence per question on the round.

## Time

- **TTD** (time to diagnose): `attacked_at` → the **first** `submit_diagnosis`. Revisions do not move it.
- **TTM** (time to mitigate): `attacked_at` → the first moment the oracle reports healed.
- `attacked_at` is the first probe cycle after injection with an in-scope probe red.

## Attacker points

```
base   = fault.points × (decoy attached ? 1.5 : 1)      singles 10, combos 30
points = base                 if the round is NOT healed
       = 0.5 × base           if healed but the judge failed the diagnosis  (a lucky fix)
       = 0                    if healed with a passing diagnosis
```

Invalid rounds (the injector failed to make an in-scope probe red within 30 s) score 0 and are excluded from every aggregate.

## Healer aggregates

Over the most recent 200 `done` rounds per healer config (`packages/shared/src/scoring.ts`, unit-tested):

| metric | definition |
| --- | --- |
| `heal_rate` | healed / rounds |
| `median_ttd_ms`, `median_ttm_ms` | medians over rounds with a value (TTM over healed rounds) |
| `diag_pass_rate` | judge pass / judged rounds |
| `p_heal_given_diag` | healed / rounds whose diagnosis passed |
| `p_heal_given_no_diag` | healed / rounds whose diagnosis failed: **the lucky-fix rate** |
| `mean_tool_calls`, `mean_tokens` | means over rounds |
| `by_fault[]` | the same, grouped by the round's primary (non-decoy) fault id |

## Healer configurations

| id | tools | prompt | budget |
| --- | --- | --- | --- |
| H1 diagnose-only | `probe_status` ×1, `diagnose_ai` ×1, `db_query` ×1, `submit_diagnosis`, one write | base + budget addendum | 4 tool calls |
| H2 agent+skill (public rounds) | all 17 | base + the vendored `insforge-debug` skill | 25 tool calls, 5 min |
| H3 agent-noskill (evaluation only) | all 17 | base | 25 tool calls, 5 min |

The H2 versus H3 delta is what the `insforge-debug` skill is worth, measured.
