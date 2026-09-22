/**
 * `pnpm --filter @bmb/referee heal --fault F01 [--config H2] [--no-reset]`
 *
 * Runs one full round against the victim with the live model and prints the event stream:
 * inject → attacked → healer transcript → verdict → reset. Needs ANTHROPIC_API_KEY in .env.
 */
import type { FaultId, HealerConfigId } from '@bmb/shared';
import { getFault } from '@bmb/shared';
import { loadEnv } from '../env.js';
import { hasModelCredentials } from '../healer/provider.js';
import { runRound } from '../round.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const env = loadEnv();
const faultArg = flag('--fault') ?? 'F01';
const faultIds = faultArg.split(',').map((s) => s.trim()) as FaultId[];
for (const id of faultIds) if (!getFault(id)) throw new Error(`unknown fault ${id}`);
const configId = (flag('--config') ?? 'H2') as HealerConfigId;
if (!hasModelCredentials(env)) {
  console.error(
    `no model credentials for LLM_PROVIDER=${env.LLM_PROVIDER}: set ANTHROPIC_API_KEY or LLM_API_KEY in apps/referee/.env`,
  );
  process.exit(2);
}

console.log(
  `round: faults=${faultIds.join('+')} config=${configId} provider=${env.LLM_PROVIDER} model=${env.HEALER_MODEL}`,
);
const result = await runRound({
  env,
  faultIds,
  configId,
  skipReset: process.argv.includes('--no-reset'),
  log: (line) => console.log(line),
});

const { events, ...rest } = result;
console.log('\n=== result');
console.log(JSON.stringify({ ...rest, eventCount: events.length }, null, 2));
process.exit(result.status === 'healed' ? 0 : 1);
