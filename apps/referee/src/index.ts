/**
 * Referee entry point.
 *
 * Phase 0: skeleton only. The main loop (poll bmb-control for queued rounds, inject, probe,
 * run the healer, judge, score, reset) lands in Phases 1–5.
 */
import { PROBE_IDS } from '@bmb/shared';

export function describe(): string {
  return `break-my-backend referee (phase 0 skeleton) — probes: ${PROBE_IDS.join(', ')}`;
}

const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMain) {
  console.log(describe());
}
