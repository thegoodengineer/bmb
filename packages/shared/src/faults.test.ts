import { describe, expect, it } from 'vitest';
import { COMBO_POINTS, expandToSingles, FAULTS, PROBE_IDS, SINGLE_POINTS } from './faults.js';

/** Words that would leak the mechanism to the attacker (SPEC.md §6.4). */
const BANNED_IN_BLURB = [
  'policy',
  'rls',
  'index',
  'grant',
  'trigger',
  'constraint',
  'rename',
  'column',
  'function',
  'rpc',
];

describe('fault catalog invariants', () => {
  it('has unique ids with the right prefix for the tier', () => {
    const ids = FAULTS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FAULTS) {
      const prefix = { single: 'F', decoy: 'D', combo: 'C' }[f.tier];
      expect(f.id.startsWith(prefix), `${f.id} should start with ${prefix}`).toBe(true);
    }
  });

  it('has 10 singles, 4 decoys, 5 combos', () => {
    expect(FAULTS.filter((f) => f.tier === 'single')).toHaveLength(10);
    expect(FAULTS.filter((f) => f.tier === 'decoy')).toHaveLength(4);
    expect(FAULTS.filter((f) => f.tier === 'combo')).toHaveLength(5);
  });

  it('points: singles 10, combos 30, decoys 0', () => {
    for (const f of FAULTS) {
      if (f.tier === 'single') expect(f.points).toBe(SINGLE_POINTS);
      if (f.tier === 'combo') expect(f.points).toBe(COMBO_POINTS);
      if (f.tier === 'decoy') expect(f.points).toBe(0);
    }
  });

  it('every scope entry is a valid probe id; singles and combos have non-empty scope', () => {
    for (const f of FAULTS) {
      for (const p of f.groundTruth.scope) expect(PROBE_IDS).toContain(p);
      if (f.tier !== 'decoy') expect(f.groundTruth.scope.length).toBeGreaterThan(0);
      if (f.tier === 'decoy') expect(f.groundTruth.scope).toHaveLength(0);
    }
  });

  it('combos are composed of exactly two distinct singles and their scope is the union', () => {
    for (const f of FAULTS.filter((x) => x.tier === 'combo')) {
      expect(f.composedOf).toHaveLength(2);
      const parts = f.composedOf ?? [];
      expect(new Set(parts).size).toBe(2);
      const union = new Set<string>();
      for (const id of parts) {
        const part = FAULTS.find((x) => x.id === id);
        expect(part?.tier).toBe('single');
        for (const p of part?.groundTruth.scope ?? []) union.add(p);
      }
      expect(new Set(f.groundTruth.scope)).toEqual(union);
      expect(expandToSingles(f.id)).toEqual(parts);
    }
    for (const f of FAULTS.filter((x) => x.tier !== 'combo')) {
      expect(f.composedOf).toBeUndefined();
      expect(expandToSingles(f.id)).toEqual([f.id]);
    }
  });

  it('player-facing text is short and never hints at the mechanism', () => {
    for (const f of FAULTS) {
      expect(f.name.length, `${f.id} name too long`).toBeLessThanOrEqual(32);
      expect(f.blurb.includes('\n')).toBe(false);
      const lower = f.blurb.toLowerCase();
      for (const word of BANNED_IN_BLURB) {
        expect(lower.includes(word), `${f.id} blurb contains "${word}"`).toBe(false);
      }
    }
  });
});
