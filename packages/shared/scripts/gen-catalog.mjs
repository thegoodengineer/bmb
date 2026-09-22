#!/usr/bin/env node
// Generates docs/FAULT_CATALOG.md from the built catalog (packages/shared/dist).
// Run: pnpm docs:catalog   (root) — requires `pnpm --filter @bmb/shared build` first.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAULTS } from '../dist/index.js';

const out = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../docs/FAULT_CATALOG.md',
);

const byTier = (tier) => FAULTS.filter((f) => f.tier === tier);
const row = (cells) => `| ${cells.join(' | ')} |`;

const lines = [
  '# Fault catalog',
  '',
  '_Generated from `packages/shared/src/faults.ts` by `pnpm docs:catalog`. Do not edit by hand._',
  '',
  'The first table is what attackers see. The second is the ground truth the judge grades against;',
  'it lives in the referee process only and is never shown to the healer.',
  '',
  '## Player-facing menu',
  '',
  row(['id', 'tier', 'name', 'blurb', 'points']),
  row(['---', '---', '---', '---', '---']),
  ...FAULTS.map((f) =>
    row([
      f.id,
      f.tier,
      f.name,
      f.blurb,
      f.tier === 'decoy' ? '×1.5 on the attached single' : String(f.points),
    ]),
  ),
  '',
  '## Ground truth (referee only)',
  '',
  row(['id', 'component', 'mechanism', 'affected probes', 'composed of']),
  row(['---', '---', '---', '---', '---']),
  ...FAULTS.map((f) =>
    row([
      f.id,
      f.groundTruth.component,
      f.groundTruth.mechanism,
      f.groundTruth.scope.join(', ') || '(none: decoy)',
      f.composedOf?.join(' + ') ?? '',
    ]),
  ),
  '',
  '## Probes',
  '',
  '| id | probe | pass condition |',
  '| --- | --- | --- |',
  '| P1 | login | token obtained |',
  '| P2 | list_notes | 200, exactly 20 rows, all owned by the probe user, each with title and body, under `P2_MAX_MS` |',
  '| P3 | create then delete | both succeed, created row round-trips title/body |',
  "| P4 | rpc note_count | exactly 25 (the probe user's real count) |",
  '| P5 | invoke summarize | 200, non-empty summary, words > 0 |',
  '| P6 | update_note | 200 and updated_at advanced |',
  '',
  `Singles: ${byTier('single').length} · Decoys: ${byTier('decoy').length} · Combos: ${byTier('combo').length}`,
  '',
];

writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out} (${FAULTS.length} faults)`);
