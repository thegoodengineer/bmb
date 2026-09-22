import { describe, expect, it } from 'vitest';
import { buildConfig, compactSkillText, readSkillText } from '../src/healer/configs.js';
import { TOOL_DEFINITIONS } from '../src/healer/tools.js';

/** Rough token estimate (≈3.6 chars per token for this mix of prose, tables and code). */
const tokens = (s: string) => Math.round(s.length / 3.6);

describe('compact skill for rate-limited providers', () => {
  const compact = compactSkillText();

  it('keeps the primitives table and the app-level recipes', () => {
    expect(compact).toContain('## Debug Primitives');
    expect(compact).toContain('### Recipe: RLS access issue');
    expect(compact).toContain('### Recipe: Edge function runtime error');
    expect(compact).toContain('### Recipe: Single slow query');
    expect(compact).toContain("### Recipe: Don't know where to start");
  });

  it('drops frontmatter and platform-operations sections', () => {
    expect(compact).not.toMatch(/^---/);
    expect(compact).not.toContain('Memory is at ~80%');
    expect(compact).not.toContain('When the Root Cause Is InsForge Itself');
    expect(compact).not.toContain('`deployments deploy` failed');
  });

  it('is well under half the full SKILL.md', () => {
    expect(compact.length).toBeLessThan(readSkillText(false).length / 2);
  });

  it('keeps a compact H2 request under a 7k-token per-minute cap with room for history', () => {
    const fixed =
      tokens(buildConfig('H2', { skill: 'compact' }).systemPrompt) +
      tokens(JSON.stringify(TOOL_DEFINITIONS));
    expect(fixed).toBeLessThan(4500);
  });

  it('contains no catalog ids', () => {
    expect(/\b[FDC]0\d\b/.test(buildConfig('H2', { skill: 'compact' }).systemPrompt)).toBe(false);
  });
});
