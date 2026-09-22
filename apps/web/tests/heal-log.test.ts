import { describe, expect, it } from 'vitest';
import type { PublicEvent } from '../lib/control';
import { collapseProbes } from '../lib/heal-log';

let id = 0;
const probe = (red: string[]): PublicEvent => ({
  id: ++id,
  round_id: 'r',
  at: new Date(1_790_000_000_000 + id * 3000).toISOString(),
  kind: 'probe',
  payload: {
    results: ['P1', 'P2', 'P3'].map((name) => ({ name, ok: !red.includes(name) })),
  },
});
const other = (kind: string): PublicEvent => ({
  id: ++id,
  round_id: 'r',
  at: new Date(1_790_000_000_000 + id * 3000).toISOString(),
  kind,
  payload: {},
});

describe('collapseProbes', () => {
  it('folds consecutive probe cycles with the same red set', () => {
    const rows = collapseProbes([probe(['P2']), probe(['P2']), probe(['P2']), probe([])]);
    expect(rows.map((r) => r.repeats)).toEqual([3, 1]);
  });

  it('keeps folding across interleaved healer events until the red set changes', () => {
    const rows = collapseProbes([
      probe(['P2', 'P3']),
      other('tool_call'),
      probe(['P2', 'P3']),
      other('tool_result'),
      probe(['P3']),
    ]);
    expect(rows.map((r) => `${r.e.kind}:${r.repeats}`)).toEqual([
      'probe:2',
      'tool_call:1',
      'tool_result:1',
      'probe:1',
    ]);
  });
});
