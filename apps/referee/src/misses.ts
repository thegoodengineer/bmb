import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FaultId, HealerConfigId } from '@bmb/shared';
import { REFEREE_ROOT } from './env.js';
import type { JudgeVerdict } from './judge.js';
import type { RoundResult } from './round.js';

/**
 * docs/MISSES.md is appended automatically whenever a round is unhealed or the judge fails
 * the diagnosis (SPEC.md §12). Each entry is a template Abhijeet edits before publishing.
 * The file lives in the repo when the referee runs from the checkout; on a compute service
 * MISSES_DIR points somewhere writable and the entries are copied back by hand.
 */
export interface MissInput {
  roundId: string;
  faultIds: FaultId[];
  configId: HealerConfigId;
  result: RoundResult;
  judge: JudgeVerdict | undefined;
  diagnosis: Record<string, unknown> | undefined;
}

export function missesPath(): string {
  const dir = process.env.MISSES_DIR ?? path.resolve(REFEREE_ROOT, '../../docs');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, 'MISSES.md');
}

export async function appendMiss(input: MissInput): Promise<void> {
  const file = missesPath();
  if (!existsSync(file)) {
    appendFileSync(
      file,
      '# Misses\n\nEvery round where the healer failed to heal or the judge failed the diagnosis. Appended automatically by the referee; entries are edited by hand before publishing. Tone: neutral, reproducible.\n',
    );
  }
  const aiSaid = input.result.events
    .filter((e) => e.kind === 'tool_result' && String(e.payload.name) === 'diagnose_ai')
    .map((e) => String(e.payload.preview ?? ''))
    .join('\n');
  const fixes = input.result.events
    .filter((e) => e.kind === 'fix_applied')
    .map((e) =>
      `  - ${String(e.payload.tool)}: ${String(e.payload.sql ?? e.payload.slug ?? '')}`.slice(
        0,
        300,
      ),
    )
    .join('\n');
  const entry = `
## ${new Date().toISOString().slice(0, 16)} · ${input.faultIds.join('+')} · ${input.configId} · round ${input.roundId}

- **Outcome:** ${input.result.status}${input.result.unhealedReason ? ` (${input.result.unhealedReason})` : ''}; judge ${input.judge ? `${input.judge.score}/9 ${input.judge.pass ? 'pass' : 'FAIL'}` : 'not run'}
- **What \`diagnose --ai\` said:** ${aiSaid ? aiSaid.replace(/\s+/g, ' ').slice(0, 600) : '(not called)'}
- **What the healer diagnosed:** ${input.diagnosis ? `${String(input.diagnosis.component)} — ${String(input.diagnosis.mechanism)}` : '(no diagnosis)'}
- **What was actually wrong:** _(fill from docs/FAULT_CATALOG.md ground truth)_
- **What fixed it:** ${fixes || '  (no fix applied; reference fix at reset)'}
- **Judge evidence:** ${
    input.judge
      ? input.judge.evidence
          .map((e, i) => `${i + 1}${input.judge?.answers[i] ? '✓' : '✗'} ${e}`)
          .join('; ')
          .slice(0, 900)
      : '-'
  }
- **Upstream:** _(link issue/PR if filed)_
`;
  appendFileSync(file, entry);
}
