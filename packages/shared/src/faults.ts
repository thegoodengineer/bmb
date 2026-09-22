/**
 * THE FAULT CATALOG — data only. Injection code lives in apps/referee/src/injector.
 *
 * This module is imported by the referee and the web app. It must NEVER be stringified
 * into a healer prompt or tool result; `groundTruth` is the answer key the judge grades
 * against. A test in apps/referee greps every healer-facing file for fault ids.
 *
 * Player-facing text (`name`, `blurb`) must not hint at the mechanism; see the invariants
 * test for the banned words.
 */

export type FaultTier = 'single' | 'decoy' | 'combo';

export type ProbeId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

export const PROBE_IDS: readonly ProbeId[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;

export type FaultId = `F${string}` | `D${string}` | `C${string}`;

export interface FaultGroundTruth {
  /** e.g. 'notes table RLS', 'summarize edge function' */
  component: string;
  /** e.g. 'select policy replaced with using(false)' */
  mechanism: string;
  /** Probes that are legitimately affected by this fault (verified by test/faults.test.ts). */
  scope: ProbeId[];
}

export interface Fault {
  id: FaultId;
  tier: FaultTier;
  /** Player-facing, at most 32 characters. */
  name: string;
  /** Player-facing, one line, must not hint at the mechanism. */
  blurb: string;
  points: number;
  /** Never leaves the referee process. */
  groundTruth: FaultGroundTruth;
  /** For combos: exactly two single fault ids. */
  composedOf?: FaultId[];
}

export const SINGLE_POINTS = 10;
export const COMBO_POINTS = 30;
export const DECOY_MULTIPLIER = 1.5;

const singles: Fault[] = [
  {
    id: 'F01',
    tier: 'single',
    name: 'Lockout',
    blurb: 'Every note vanishes for everyone who is logged in.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table row-level security (select policy notes_select_own)',
      mechanism: 'the select policy was replaced with USING (false), so no row is visible',
      // P3 is in scope because insert().select() needs the select policy for RETURNING.
      scope: ['P2', 'P3', 'P4', 'P5', 'P6'],
    },
  },
  {
    id: 'F02',
    tier: 'single',
    name: 'Molasses',
    blurb: 'Listing notes still works. Eventually.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table index notes_owner_created_idx on (owner_id, created_at desc)',
      mechanism: 'the composite index was dropped; listing falls back to a sequential scan',
      scope: ['P2'],
    },
  },
  {
    id: 'F03',
    tier: 'single',
    name: 'Revoked',
    blurb: 'Reading notes is suddenly off the menu.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table privileges for role authenticated',
      mechanism: 'SELECT was revoked from authenticated (policies are intact but unreachable)',
      scope: ['P2', 'P3', 'P4', 'P5', 'P6'],
    },
  },
  {
    id: 'F04',
    tier: 'single',
    name: 'Dead Function',
    blurb: 'Summaries stop coming back. Nothing else changes.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'summarize edge function',
      mechanism:
        'redeployed with a source whose handler throws on every request, so every invoke is a 500',
      scope: ['P5'],
    },
  },
  {
    id: 'F05',
    tier: 'single',
    name: 'Renamed',
    blurb: "The app's data looks subtly off-shape.",
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table schema (column body)',
      mechanism: 'column body was renamed to content',
      scope: ['P2', 'P3', 'P5'],
    },
  },
  {
    id: 'F06',
    tier: 'single',
    name: 'Poison Pill',
    blurb: 'Nobody can write a new note. Reads are fine.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table trigger notes_block (function bmb_block)',
      mechanism: 'a BEFORE INSERT trigger raises an exception on every insert',
      scope: ['P3'],
    },
  },
  {
    id: 'F07',
    tier: 'single',
    name: 'Vanished RPC',
    blurb: 'The note counter is gone.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'database function public.note_count() (RPC)',
      mechanism: 'the function was dropped; the RPC returns 404 PGRST202',
      scope: ['P4'],
    },
  },
  {
    id: 'F08',
    tier: 'single',
    name: 'Impossible Rule',
    blurb: 'New notes are rejected no matter what you type.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table check constraint notes_title_impossible',
      mechanism:
        'a CHECK (length(title) < 1) constraint makes every insert and update of a note fail',
      // P6 is in scope: CHECK constraints are evaluated on UPDATE too, and P6 rewrites the title.
      scope: ['P3', 'P6'],
    },
  },
  {
    id: 'F09',
    tier: 'single',
    name: 'Wrong Owner',
    blurb: 'The note counter is confidently wrong.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'database function public.note_count() (RPC) body',
      mechanism: 'the predicate was flipped to owner_id <> auth.uid(), returning other users count',
      scope: ['P4'],
    },
  },
  {
    id: 'F10',
    tier: 'single',
    name: 'Quiet Update',
    blurb: 'Edits save, but something stops keeping time.',
    points: SINGLE_POINTS,
    groundTruth: {
      component: 'notes table trigger notes_touch (function touch_updated_at)',
      mechanism: 'the BEFORE UPDATE trigger was dropped; updated_at is no longer maintained',
      scope: ['P6'],
    },
  },
];

const decoys: Fault[] = [
  {
    id: 'D01',
    tier: 'decoy',
    name: 'Log Storm',
    blurb: 'A flood of noisy warnings and a new endpoint. Harmless. Probably.',
    points: 0,
    groundTruth: {
      component: 'audit_log table + extra edge function legacy-ping',
      mechanism: '500 warn rows and a second function that logs a warning; nothing user-facing',
      scope: [],
    },
  },
  {
    id: 'D02',
    tier: 'decoy',
    name: 'Bloat',
    blurb: 'A big unprotected copy of the data appears.',
    points: 0,
    groundTruth: {
      component: 'extra table scratch_export',
      mechanism: 'a copy of notes without RLS or indexes; advisor flags it, users never touch it',
      scope: [],
    },
  },
  {
    id: 'D03',
    tier: 'decoy',
    name: 'Slow Neighbor',
    blurb: 'Something slow shows up in the stats, unrelated to anything.',
    points: 0,
    groundTruth: {
      component: 'extra database function report_slow()',
      mechanism: 'a pg_sleep(1.5) function called once so it appears in slow-query stats',
      scope: [],
    },
  },
  {
    id: 'D04',
    tier: 'decoy',
    name: 'Extra Policy',
    blurb: 'A suspicious new permission appears. It changes nothing.',
    points: 0,
    groundTruth: {
      component: 'profiles table policy profiles_insert_any',
      mechanism: 'a permissive insert policy on profiles; advisor warns, no probe uses it',
      scope: [],
    },
  },
];

const combos: Fault[] = [
  {
    id: 'C01',
    tier: 'combo',
    name: 'Double Lock',
    blurb: "Two reasons you can't read notes.",
    points: COMBO_POINTS,
    composedOf: ['F01', 'F03'],
    groundTruth: {
      component: 'notes table: select policy AND table privileges',
      mechanism:
        'select policy USING (false) and SELECT revoked from authenticated; fixing one leaves the other',
      scope: ['P2', 'P3', 'P4', 'P5', 'P6'],
    },
  },
  {
    id: 'C02',
    tier: 'combo',
    name: 'Two Fronts',
    blurb: 'Two different things break at once.',
    points: COMBO_POINTS,
    composedOf: ['F04', 'F06'],
    groundTruth: {
      component: 'summarize edge function AND notes table trigger notes_block',
      mechanism: 'function throws on invoke; a BEFORE INSERT trigger raises',
      scope: ['P3', 'P5'],
    },
  },
  {
    id: 'C03',
    tier: 'combo',
    name: 'Masked',
    blurb: 'One failure hides another.',
    points: COMBO_POINTS,
    composedOf: ['F05', 'F07'],
    groundTruth: {
      component: 'notes table schema (column body) AND database function note_count()',
      mechanism: 'column body renamed to content; note_count() dropped',
      scope: ['P2', 'P3', 'P4', 'P5'],
    },
  },
  {
    id: 'C04',
    tier: 'combo',
    name: 'Loud and Quiet',
    blurb: 'One thing screams, one thing whispers.',
    points: COMBO_POINTS,
    composedOf: ['F02', 'F10'],
    groundTruth: {
      component: 'notes table index notes_owner_created_idx AND trigger notes_touch',
      mechanism: 'index dropped (slow listing); update trigger dropped (stale updated_at)',
      scope: ['P2', 'P6'],
    },
  },
];

export const FAULTS: readonly Fault[] = [...singles, ...decoys, ...combos];

export const FAULT_BY_ID: ReadonlyMap<FaultId, Fault> = new Map(FAULTS.map((f) => [f.id, f]));

export function isFaultId(s: string): s is FaultId {
  return FAULT_BY_ID.has(s as FaultId);
}

export function getFault(id: string): Fault | undefined {
  return FAULT_BY_ID.get(id as FaultId);
}

export function faultsOfTier(tier: FaultTier): Fault[] {
  return FAULTS.filter((f) => f.tier === tier);
}

/** Expand a fault id into the single fault ids that must be injected (combos → their parts). */
export function expandToSingles(id: FaultId): FaultId[] {
  const f = FAULT_BY_ID.get(id);
  if (!f) throw new Error(`unknown fault ${id}`);
  return f.tier === 'combo' ? (f.composedOf ?? []) : [id];
}
