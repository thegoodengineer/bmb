/**
 * `pnpm --filter @bmb/referee reset` — apply every reference fix, clean decoys, re-seed,
 * and verify no artifact remains. Prints each CLI command it ran.
 */
import { loadEnv } from '../env.js';
import { resetVictim } from '../reset.js';

const env = loadEnv();
const report = await resetVictim(env, (cmd) => console.log(`  $ ${cmd.slice(0, 160)}`));
console.log(JSON.stringify(report, null, 2));
