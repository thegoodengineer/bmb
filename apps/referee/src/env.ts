import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Referee configuration. Loaded once from apps/referee/.env (gitignored) merged over
 * process.env, and validated with zod so a missing key fails loudly at startup.
 */
/** Model used when LLM_PROVIDER=anthropic and no model is named. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';

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
  HEALER_MODEL: z.string().default(DEFAULT_ANTHROPIC_MODEL),
  JUDGE_MODEL: z.string().default(DEFAULT_ANTHROPIC_MODEL),
  /** anthropic (default) | groq | openrouter | openai-compat — see healer/provider.ts */
  LLM_PROVIDER: z.enum(['anthropic', 'groq', 'openrouter', 'openai-compat']).default('anthropic'),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: z.string().url().optional(),
  /** Include the skill's reference files in the H2 prompt (~15k tokens). Off for free tiers. */
  HEALER_SKILL_REFERENCES: z
    .enum(['0', '1', 'true', 'false'])
    .transform((v) => v === '1' || v === 'true')
    .optional(),
  SELF_PLAY_EVERY_MIN: z.coerce.number().int().positive().default(60),
  /** Benchmark default 5 min; free tiers spend much of it waiting on rate limits. */
  HEALER_WALL_CLOCK_MS: z.coerce.number().int().positive().default(300_000),
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
  // A .env edited on Windows carries CRLF; the loader keeps the \r and keys stop matching.
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && /[\r\n]$/.test(v)) process.env[k] = v.replace(/[\r\n]+$/, '');
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
