/**
 * `pnpm --filter @bmb/referee seed` — idempotent victim seed (users, profiles, notes).
 */
import { loadEnv } from '../env.js';
import { seedVictim } from '../victim/seed.js';

const env = loadEnv();
console.log(`seeding ${env.VICTIM_URL} (target filler notes: ${env.FILLER_NOTES})`);
const report = await seedVictim(env);
console.log(JSON.stringify(report, null, 2));
