import { DECOY_MULTIPLIER, type FaultId, getFault } from './faults.js';

/**
 * Pure scoring functions (SPEC.md §8.3). No I/O, no randomness; unit-tested in scoring.test.ts.
 */

/* ------------------------------------------------------------------ attacker points */

export interface AttackerPointsInput {
  points: number;
  hasDecoy: boolean;
  healed: boolean;
  judgePass: boolean;
}

/**
 * points × (decoy ? 1.5 : 1) × (healed ? 0 : 1) + (healed && !judgePass ? 0.5 × base : 0)
 * The attacker scores fully when the round is unhealed, half when it was healed by a lucky fix.
 */
export function attackerPoints(input: AttackerPointsInput): number {
  const base = input.points * (input.hasDecoy ? DECOY_MULTIPLIER : 1);
  if (!input.healed) return base;
  return input.judgePass ? 0 : 0.5 * base;
}

/** Points for a round from its fault ids (a scored fault plus optional decoys). */
export function roundPoints(faultIds: FaultId[]): { points: number; hasDecoy: boolean } {
  const scored = faultIds.map((id) => getFault(id)).filter((f) => f && f.tier !== 'decoy');
  const hasDecoy = faultIds.some((id) => getFault(id)?.tier === 'decoy');
  const points = scored.reduce((sum, f) => sum + (f?.points ?? 0), 0);
  return { points, hasDecoy };
}

/* ------------------------------------------------------------------ healer aggregates */

/** The subset of a `rounds` row the aggregates need. */
export interface ScoredRound {
  fault_ids: string[];
  healer_config: string;
  status: string;
  healed: boolean | null;
  judge_pass: boolean | null;
  ttd_ms: number | null;
  ttm_ms: number | null;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
}

export interface HealerStats {
  config: string;
  rounds: number;
  heal_rate: number;
  median_ttd_ms: number | null;
  median_ttm_ms: number | null;
  diag_pass_rate: number;
  /** P(healed | diagnosis passed) */
  p_heal_given_diag: number | null;
  /** P(healed | diagnosis failed) — the lucky-fix rate */
  p_heal_given_no_diag: number | null;
  mean_tool_calls: number;
  mean_tokens: number;
  by_fault: FaultStats[];
}

export interface FaultStats {
  fault_id: string;
  rounds: number;
  heal_rate: number;
  diag_pass_rate: number;
  median_ttm_ms: number | null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const lo = s[mid - 1];
  const hi = s[mid];
  if (hi === undefined) return null;
  return s.length % 2 === 1 ? hi : lo === undefined ? hi : (lo + hi) / 2;
}

function rate(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/** Primary (scored) fault id of a round: the combo or single, never a decoy. */
export function primaryFaultId(faultIds: string[]): string | undefined {
  return faultIds.find((id) => !id.startsWith('D'));
}

/**
 * Aggregates over `done` rounds only, per healer config, most recent `limit` rounds
 * (callers pass rounds newest-first).
 */
export function aggregateRounds(rounds: ScoredRound[], config: string, limit = 200): HealerStats {
  const done = rounds
    .filter((r) => r.status === 'done' && r.healer_config === config)
    .slice(0, limit);
  const healed = done.filter((r) => r.healed === true);
  const judged = done.filter((r) => r.judge_pass !== null);
  const diagPassed = judged.filter((r) => r.judge_pass === true);
  const diagFailed = judged.filter((r) => r.judge_pass === false);

  const byFault = new Map<string, ScoredRound[]>();
  for (const r of done) {
    const id = primaryFaultId(r.fault_ids);
    if (!id) continue;
    byFault.set(id, [...(byFault.get(id) ?? []), r]);
  }

  return {
    config,
    rounds: done.length,
    heal_rate: rate(healed.length, done.length),
    median_ttd_ms: median(done.flatMap((r) => (r.ttd_ms === null ? [] : [r.ttd_ms]))),
    median_ttm_ms: median(healed.flatMap((r) => (r.ttm_ms === null ? [] : [r.ttm_ms]))),
    diag_pass_rate: rate(diagPassed.length, judged.length),
    p_heal_given_diag:
      diagPassed.length === 0
        ? null
        : rate(diagPassed.filter((r) => r.healed).length, diagPassed.length),
    p_heal_given_no_diag:
      diagFailed.length === 0
        ? null
        : rate(diagFailed.filter((r) => r.healed).length, diagFailed.length),
    mean_tool_calls:
      done.length === 0 ? 0 : done.reduce((s, r) => s + r.tool_calls, 0) / done.length,
    mean_tokens:
      done.length === 0
        ? 0
        : done.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0) / done.length,
    by_fault: [...byFault.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fault_id, rs]) => {
        const h = rs.filter((r) => r.healed === true);
        const j = rs.filter((r) => r.judge_pass !== null);
        return {
          fault_id,
          rounds: rs.length,
          heal_rate: rate(h.length, rs.length),
          diag_pass_rate: rate(j.filter((r) => r.judge_pass === true).length, j.length),
          median_ttm_ms: median(h.flatMap((r) => (r.ttm_ms === null ? [] : [r.ttm_ms]))),
        };
      }),
  };
}
