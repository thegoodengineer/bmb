import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Referee configuration. Loaded once from apps/referee/.env (gitignored) merged over
 * process.env, and validated with zod so a missing key fails loudly at startup.
 */
const envSchema = z.object({
  VICTIM_URL: z.string().url(),
  VICTIM_ANON_KEY: z.string().min(1),
  VICTIM_API_KEY: z.string().min(1),
  VICTIM_DIR: z.string().default('../../victim'),

  PROBE_EMAIL: z.string().email().default('probe@bmb.local'),
  PROBE_PASSWORD: z.string().min(8),
  FILLER_EMAIL: z.string().email().default('filler@bmb.local'),
  FILLER_PASSWORD: z.string().min(8),
  FILLER_NOTES: z.coerce.number().int().positive().default(400_000),
  P2_MAX_MS: z.coerce.number().int().positive().default(400),

  CONTROL_URL: z.string().url().optional(),
  CONTROL_API_KEY: z.string().min(1).optional(),

  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  HEALER_MODEL: z.string().default('claude-sonnet-5'),
  JUDGE_MODEL: z.string().default('claude-sonnet-5'),
});

export type Env = z.infer<typeof envSchema>;

/** apps/referee, whether running from src/ (tsx) or dist/ (tsc). */
export const REFEREE_ROOT = fileURLToPath(new URL('..', import.meta.url));

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  try {
    process.loadEnvFile(path.join(REFEREE_ROOT, '.env'));
  } catch {
    // No .env file: rely on process.env (CI / compute service).
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`referee env invalid: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Absolute path of the InsForge-linked victim directory every CLI call runs in. */
export function victimDir(env: Env = loadEnv()): string {
  return path.resolve(REFEREE_ROOT, env.VICTIM_DIR);
}
