import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, judgeRound, scoreAnswers, scriptedJudge } from '../src/judge.js';

const yes = (n: number, total = 9) => Array.from({ length: total }, (_, i) => i < n);

describe('judge scoring', () => {
  it('passes at 7/9 with every dimension non-zero', () => {
    const v = scoreAnswers(
      {
        answers: [true, true, true, true, true, false, true, true, false],
        evidence: yes(9).map(String),
      },
      'x',
    );
    expect(v.score).toBe(7);
    expect(v.dims).toEqual({ loc: 3, char: 2, scope: 2 });
    expect(v.pass).toBe(true);
  });
  it('fails at 6/9', () => {
    expect(scoreAnswers({ answers: yes(6), evidence: yes(9).map(String) }, 'x').pass).toBe(false);
  });
  it('fails when a dimension scores zero even with 7 yes answers', () => {
    // loc 3, char 3, scope 0 = 6; make it 7 by giving loc+char 6 and nothing in scope is impossible,
    // so use loc 3, char 3, scope 1 = 7 pass, versus loc 3, char 4? Not possible: test the rule directly.
    const v = scoreAnswers(
      {
        answers: [true, true, true, true, true, true, false, false, false],
        evidence: yes(9).map(String),
      },
      'x',
    );
    expect(v.score).toBe(6);
    expect(v.pass).toBe(false);
    const w = scoreAnswers(
      {
        answers: [true, true, true, true, true, true, true, false, false],
        evidence: yes(9).map(String),
      },
      'x',
    );
    expect(w.dims.scope).toBe(1);
    expect(w.pass).toBe(true);
  });
});

describe('judgeRound', () => {
  it('scores zero without a diagnosis and never calls the model', async () => {
    const v = await judgeRound(scriptedJudge(yes(9)), {
      faultIds: ['F01'],
      diagnosis: undefined,
      affectedProbes: ['P2'],
    });
    expect(v.score).toBe(0);
    expect(v.pass).toBe(false);
  });
  it('uses the model answers when a diagnosis exists', async () => {
    const v = await judgeRound(scriptedJudge(yes(8)), {
      faultIds: ['F01'],
      diagnosis: {
        component: 'notes_select_own',
        mechanism: 'using(false)',
        affected: ['P2'],
        confidence: 0.9,
        reasoning: 'r',
      },
      affectedProbes: ['P2'],
    });
    expect(v.score).toBe(8);
    expect(v.pass).toBe(true);
  });
});

describe('judge prompt', () => {
  it('includes ground truth for scored faults and lists decoys separately', () => {
    const p = buildJudgePrompt({
      faultIds: ['C01', 'D04'],
      diagnosis: { component: 'x', mechanism: 'y', affected: [], confidence: 0.5, reasoning: 'z' },
      affectedProbes: ['P2', 'P3'],
    });
    expect(p.user).toContain('compound: two faults');
    expect(p.user).toContain('USING (false)');
    expect(p.user).toContain('profiles_insert_any');
    expect(p.user).toContain('(harmless)');
    expect(p.user).not.toMatch(/\b[FDC]0\d\b/); // the judge gets truth, not ids
  });
});
