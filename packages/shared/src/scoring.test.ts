import { describe, expect, it } from 'vitest';
import {
  aggregateRounds,
  attackerPoints,
  median,
  roundPoints,
  type ScoredRound,
} from './scoring.js';

describe('attackerPoints', () => {
  it('scores fully when unhealed', () => {
    expect(attackerPoints({ points: 10, hasDecoy: false, healed: false, judgePass: false })).toBe(
      10,
    );
    expect(attackerPoints({ points: 10, hasDecoy: false, healed: false, judgePass: true })).toBe(
      10,
    );
  });
  it('multiplies by 1.5 with a decoy', () => {
    expect(attackerPoints({ points: 10, hasDecoy: true, healed: false, judgePass: false })).toBe(
      15,
    );
    expect(attackerPoints({ points: 30, hasDecoy: true, healed: false, judgePass: false })).toBe(
      45,
    );
  });
  it('scores zero when healed with a passing diagnosis', () => {
    expect(attackerPoints({ points: 10, hasDecoy: true, healed: true, judgePass: true })).toBe(0);
  });
  it('scores half on a lucky fix (healed, diagnosis failed)', () => {
    expect(attackerPoints({ points: 10, hasDecoy: false, healed: true, judgePass: false })).toBe(5);
    expect(attackerPoints({ points: 30, hasDecoy: true, healed: true, judgePass: false })).toBe(
      22.5,
    );
  });
});

describe('roundPoints', () => {
  it('reads points and decoy flag from the catalog', () => {
    expect(roundPoints(['F01'])).toEqual({ points: 10, hasDecoy: false });
    expect(roundPoints(['F02', 'D01'])).toEqual({ points: 10, hasDecoy: true });
    expect(roundPoints(['C01', 'D04'])).toEqual({ points: 30, hasDecoy: true });
  });
});

describe('median', () => {
  it('handles empty, odd and even', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

function round(over: Partial<ScoredRound>): ScoredRound {
  return {
    fault_ids: ['F01'],
    healer_config: 'H2',
    status: 'done',
    healed: true,
    judge_pass: true,
    ttd_ms: 10_000,
    ttm_ms: 20_000,
    tool_calls: 5,
    tokens_in: 1000,
    tokens_out: 200,
    ...over,
  };
}

describe('aggregateRounds', () => {
  const rounds: ScoredRound[] = [
    round({}),
    round({ fault_ids: ['F02', 'D01'], healed: true, judge_pass: false, ttm_ms: 40_000 }),
    round({ fault_ids: ['F09'], healed: false, judge_pass: false, ttm_ms: null }),
    round({ fault_ids: ['C01'], healed: true, judge_pass: true, ttm_ms: 60_000 }),
    round({ healer_config: 'H3', healed: false, judge_pass: false, ttm_ms: null }),
    round({ status: 'invalid', healed: null, judge_pass: null }),
  ];

  it('filters by config and done status', () => {
    const h2 = aggregateRounds(rounds, 'H2');
    expect(h2.rounds).toBe(4);
    expect(aggregateRounds(rounds, 'H3').rounds).toBe(1);
    expect(aggregateRounds(rounds, 'H1').rounds).toBe(0);
  });

  it('computes rates, medians and the lucky-fix rate', () => {
    const h2 = aggregateRounds(rounds, 'H2');
    expect(h2.heal_rate).toBe(0.75);
    expect(h2.diag_pass_rate).toBe(0.5);
    expect(h2.median_ttd_ms).toBe(10_000);
    expect(h2.median_ttm_ms).toBe(40_000);
    expect(h2.p_heal_given_diag).toBe(1);
    // two rounds with a failed diagnosis: one healed (lucky), one not
    expect(h2.p_heal_given_no_diag).toBe(0.5);
    expect(h2.mean_tool_calls).toBe(5);
    expect(h2.mean_tokens).toBe(1200);
  });

  it('breaks down by primary fault, ignoring decoys', () => {
    const h2 = aggregateRounds(rounds, 'H2');
    expect(h2.by_fault.map((f) => f.fault_id)).toEqual(['C01', 'F01', 'F02', 'F09']);
    const f02 = h2.by_fault.find((f) => f.fault_id === 'F02');
    expect(f02).toEqual({
      fault_id: 'F02',
      rounds: 1,
      heal_rate: 1,
      diag_pass_rate: 0,
      median_ttm_ms: 40_000,
    });
  });

  it('respects the limit on most recent rounds', () => {
    expect(aggregateRounds(rounds, 'H2', 2).rounds).toBe(2);
  });
});
