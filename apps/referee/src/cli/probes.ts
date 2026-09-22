/**
 * `pnpm --filter @bmb/referee probes [--times N] [--interval MS] [--streak K]`
 *
 * Runs the synthetic-user probe suite N times (default 4) against the victim and prints
 * per-probe status and latency. Passes (exit 0) when at least K consecutive cycles were
 * all-green (default 3), which is exactly the oracle's "green ×3" condition. The first cycle
 * after an idle period is routinely slow (cold TLS, cold Deno isolate, cold buffer cache),
 * so a single red cycle followed by three green ones is a healthy backend.
 */
import { loadEnv } from '../env.js';
import { allGreen, formatProbeLine, runProbeSuite } from '../probes.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN;
  return Number.isFinite(v) ? v : fallback;
}

const env = loadEnv();
const times = arg('--times', 4);
const interval = arg('--interval', 3000);
const needStreak = arg('--streak', 3);
let streak = 0;
let bestStreak = 0;
let greenCycles = 0;

for (let cycle = 1; cycle <= times; cycle++) {
  const results = await runProbeSuite(env);
  const green = allGreen(results);
  if (green) {
    greenCycles++;
    streak++;
    bestStreak = Math.max(bestStreak, streak);
  } else {
    streak = 0;
  }
  console.log(`cycle ${cycle}/${times}  ${green ? 'ALL GREEN' : 'RED'}  (${env.VICTIM_URL})`);
  for (const r of results) console.log(`  ${formatProbeLine(r)}`);
  if (cycle < times) await new Promise((r) => setTimeout(r, interval));
}

const pass = bestStreak >= needStreak;
console.log(
  `${greenCycles}/${times} cycles green, longest streak ${bestStreak} (need ${needStreak}) -> ${pass ? 'PASS' : 'FAIL'}`,
);
process.exit(pass ? 0 : 1);
