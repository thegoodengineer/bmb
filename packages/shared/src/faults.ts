/**
 * THE FAULT CATALOG — data only. Injection code lives in apps/referee/src/injector.
 *
 * This module is imported by the referee and the web app. It must NEVER be stringified
 * into a healer prompt or tool result; `groundTruth` is the answer key the judge grades
 * against. A test in apps/referee greps every healer-facing file for fault ids.
 *
 * Phase 0: types and probe ids only. The catalog entries land in Phase 2 with the injectors.
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
  /** Probes that are legitimately affected by this fault. */
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

/** Populated in Phase 2. Kept empty in Phase 0 so the skeleton typechecks. */
export const FAULTS: readonly Fault[] = [];
