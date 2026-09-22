import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAULTS } from '@bmb/shared';
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/healer/configs.js';
import { scrubCatalogIds, TOOL_DEFINITIONS } from '../src/healer/tools.js';

/**
 * Ground-truth isolation (SPEC.md §4). The healer must never see fault ids, the catalog, or
 * ground truth. Three layers are checked:
 *  1. static: nothing under src/healer or prompts mentions a catalog id or imports the catalog
 *  2. built:  the three system prompts and the tool definitions contain no catalog id and
 *             none of the ground-truth mechanism strings
 *  3. runtime: the tool-result scrubber removes anything shaped like a catalog id
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const CATALOG_ID = /\b[FDC]0\d\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('ground-truth isolation', () => {
  const healerFiles = [...walk(path.join(root, 'src/healer')), ...walk(path.join(root, 'prompts'))];

  it('scans a meaningful set of healer files', () => {
    expect(healerFiles.length).toBeGreaterThan(8);
  });

  it('no healer source or prompt file contains a catalog id', () => {
    for (const f of healerFiles) {
      const text = readFileSync(f, 'utf8');
      expect(CATALOG_ID.test(text), `${path.relative(root, f)} mentions a catalog id`).toBe(false);
    }
  });

  it('healer code never imports the catalog or ground truth', () => {
    for (const f of healerFiles.filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(f, 'utf8');
      expect(
        /\bFAULTS\b|getFault|groundTruth|faultsOfTier|expandToSingles/.test(text),
        path.relative(root, f),
      ).toBe(false);
      expect(
        /from '\.\.\/injector|from '\.\.\/reset|from '\.\.\/oracle'/.test(text),
        path.relative(root, f),
      ).toBe(false);
    }
  });

  it('built system prompts and tool definitions carry no ids or mechanisms', () => {
    const mechanisms = FAULTS.map((f) => f.groundTruth.mechanism);
    const texts = [
      ...(['H1', 'H2', 'H3'] as const).map((id) => buildConfig(id).systemPrompt),
      JSON.stringify(TOOL_DEFINITIONS),
    ];
    for (const t of texts) {
      expect(CATALOG_ID.test(t)).toBe(false);
      for (const m of mechanisms) expect(t.includes(m), `prompt contains "${m}"`).toBe(false);
    }
  });

  it('tool results are scrubbed of id-shaped tokens', () => {
    expect(scrubCatalogIds('row F01 and D04 and C02')).toBe(
      'row [redacted] and [redacted] and [redacted]',
    );
    expect(scrubCatalogIds('F0 F001 XF01')).toBe('F0 F001 XF01');
  });

  it('the base prompt is under 600 words', () => {
    const words = readFileSync(path.join(root, 'prompts/base.md'), 'utf8')
      .split(/\s+/)
      .filter(Boolean);
    expect(words.length).toBeLessThan(600);
  });
});
