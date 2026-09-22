# Fault catalog

_Generated from `packages/shared/src/faults.ts` by `pnpm docs:catalog`. Do not edit by hand._

The first table is what attackers see. The second is the ground truth the judge grades against;
it lives in the referee process only and is never shown to the healer.

## Player-facing menu

| id | tier | name | blurb | points |
| --- | --- | --- | --- | --- |
| F01 | single | Lockout | Every note vanishes for everyone who is logged in. | 10 |
| F02 | single | Molasses | Listing notes still works. Eventually. | 10 |
| F03 | single | Revoked | Reading notes is suddenly off the menu. | 10 |
| F04 | single | Dead Function | Summaries stop coming back. Nothing else changes. | 10 |
| F05 | single | Renamed | The app's data looks subtly off-shape. | 10 |
| F06 | single | Poison Pill | Nobody can write a new note. Reads are fine. | 10 |
| F07 | single | Vanished RPC | The note counter is gone. | 10 |
| F08 | single | Impossible Rule | New notes are rejected no matter what you type. | 10 |
| F09 | single | Wrong Owner | The note counter is confidently wrong. | 10 |
| F10 | single | Quiet Update | Edits save, but something stops keeping time. | 10 |
| D01 | decoy | Log Storm | A flood of noisy warnings and a new endpoint. Harmless. Probably. | ×1.5 on the attached single |
| D02 | decoy | Bloat | A big unprotected copy of the data appears. | ×1.5 on the attached single |
| D03 | decoy | Slow Neighbor | Something slow shows up in the stats, unrelated to anything. | ×1.5 on the attached single |
| D04 | decoy | Extra Policy | A suspicious new permission appears. It changes nothing. | ×1.5 on the attached single |
| C01 | combo | Double Lock | Two reasons you can't read notes. | 30 |
| C02 | combo | Two Fronts | Two different things break at once. | 30 |
| C03 | combo | Masked | One failure hides another. | 30 |
| C04 | combo | Loud and Quiet | One thing screams, one thing whispers. | 30 |
| C05 | combo | Double Silence | Two things are subtly wrong. Neither screams. | 30 |

## Ground truth (referee only)

| id | component | mechanism | affected probes | composed of |
| --- | --- | --- | --- | --- |
| F01 | notes table row-level security (select policy notes_select_own) | the select policy was replaced with USING (false), so no row is visible | P2, P3, P4, P5, P6 |  |
| F02 | notes table index notes_owner_created_idx on (owner_id, created_at desc) | the composite index was dropped; listing falls back to a sequential scan | P2 |  |
| F03 | notes table privileges for role authenticated | SELECT was revoked from authenticated (policies are intact but unreachable) | P2, P3, P4, P5, P6 |  |
| F04 | summarize edge function | redeployed with a source whose handler throws on every request, so every invoke is a 500 | P5 |  |
| F05 | notes table schema (column body) | column body was renamed to content | P2, P3, P5 |  |
| F06 | notes table trigger notes_block (function bmb_block) | a BEFORE INSERT trigger raises an exception on every insert | P3 |  |
| F07 | database function public.note_count() (RPC) | the function was dropped; the RPC returns 404 PGRST202 | P4 |  |
| F08 | notes table check constraint notes_title_impossible | a CHECK (length(title) < 1) constraint makes every insert and update of a note fail | P3, P6 |  |
| F09 | database function public.note_count() (RPC) body | the predicate was flipped to owner_id <> auth.uid(), returning other users count | P4 |  |
| F10 | notes table trigger notes_touch (function touch_updated_at) | the BEFORE UPDATE trigger was dropped; updated_at is no longer maintained | P6 |  |
| D01 | audit_log table + extra edge function legacy-ping | 500 warn rows and a second function that logs a warning; nothing user-facing | (none: decoy) |  |
| D02 | extra table scratch_export | a copy of notes without RLS or indexes; advisor flags it, users never touch it | (none: decoy) |  |
| D03 | extra database function report_slow() | a pg_sleep(1.5) function called once so it appears in slow-query stats | (none: decoy) |  |
| D04 | profiles table policy profiles_insert_any | a permissive insert policy on profiles; advisor warns, no probe uses it | (none: decoy) |  |
| C01 | notes table: select policy AND table privileges | select policy USING (false) and SELECT revoked from authenticated; fixing one leaves the other | P2, P3, P4, P5, P6 | F01 + F03 |
| C02 | summarize edge function AND notes table trigger notes_block | function throws on invoke; a BEFORE INSERT trigger raises | P3, P5 | F04 + F06 |
| C03 | notes table schema (column body) AND database function note_count() | column body renamed to content; note_count() dropped | P2, P3, P4, P5 | F05 + F07 |
| C04 | notes table index notes_owner_created_idx AND trigger notes_touch | index dropped (slow listing); update trigger dropped (stale updated_at) | P2, P6 | F02 + F10 |
| C05 | database function note_count() body AND notes table trigger notes_touch | predicate flipped to owner_id <> auth.uid(); BEFORE UPDATE trigger dropped | P4, P6 | F09 + F10 |

## Probes

| id | probe | pass condition |
| --- | --- | --- |
| P1 | login | token obtained |
| P2 | list_notes | 200, exactly 20 rows, all owned by the probe user, each with title and body, under `P2_MAX_MS` |
| P3 | create then delete | both succeed, created row round-trips title/body |
| P4 | rpc note_count | exactly 25 (the probe user's real count) |
| P5 | invoke summarize | 200, non-empty summary, words > 0 |
| P6 | update_note | 200 and updated_at advanced |

Singles: 10 · Decoys: 4 · Combos: 5
