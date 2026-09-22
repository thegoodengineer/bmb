import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { publicCatalog, isValidAttack } = await import('../lib/catalog');

describe('public catalog', () => {
  it('never carries ground truth', () => {
    const json = JSON.stringify(publicCatalog());
    expect(json).not.toContain('groundTruth');
    expect(json).not.toContain('mechanism');
    expect(json).not.toContain('scope');
  });
  it('validates attacks against the catalog', () => {
    expect(isValidAttack('F01', undefined)).toBe(true);
    expect(isValidAttack('C01', 'D02')).toBe(true);
    expect(isValidAttack('D01', undefined)).toBe(false);
    expect(isValidAttack('F01', 'F02')).toBe(false);
    expect(isValidAttack('F99', undefined)).toBe(false);
  });
});
