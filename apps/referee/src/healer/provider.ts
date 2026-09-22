import { DEFAULT_ANTHROPIC_MODEL, type Env } from '../env.js';
import { anthropicModel, type ModelClient } from './model.js';
import { type OpenAICompatOptions, openAICompatModel } from './openai-compat.js';

/**
 * Which model backs the healer and the judge (SPEC.md §2; free-tier option added after
 * Phase 8). `LLM_PROVIDER`:
 *   anthropic  — @anthropic-ai/sdk with ANTHROPIC_API_KEY (default)
 *   groq       — Groq's OpenAI-compatible endpoint with LLM_API_KEY
 *   openrouter — OpenRouter with LLM_API_KEY
 *   openai-compat — any endpoint: LLM_BASE_URL + LLM_API_KEY
 * HEALER_MODEL / JUDGE_MODEL name the model; a leftover Anthropic id on a non-Anthropic
 * provider falls back to the provider's default.
 */
const PROVIDER_DEFAULTS: Record<
  string,
  { baseUrl: string; model: string; headers?: Record<string, string> }
> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-oss-120b:free',
    headers: {
      'HTTP-Referer': 'https://github.com/thegoodengineer/bmb',
      'X-Title': 'Break My Backend',
    },
  },
  'openai-compat': { baseUrl: '', model: '' },
};

export function providerName(env: Env): string {
  return env.LLM_PROVIDER;
}

export function resolveModelId(env: Env, requested: string): string {
  if (env.LLM_PROVIDER === 'anthropic') return requested;
  const def = PROVIDER_DEFAULTS[env.LLM_PROVIDER]?.model ?? '';
  // A leftover Anthropic default on another provider falls back to that provider's default.
  return requested === DEFAULT_ANTHROPIC_MODEL && def ? def : requested;
}

/**
 * HEALER_MODEL / JUDGE_MODEL may list fallbacks, comma-separated: the first is primary,
 * the rest are tried in order when a model's quota is spent.
 */
export function modelChain(env: Env, spec: string): string[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((m) => resolveModelId(env, m));
}

export function compatOptions(env: Env, modelSpec: string, label: string): OpenAICompatOptions {
  const def = PROVIDER_DEFAULTS[env.LLM_PROVIDER];
  const baseUrl = env.LLM_BASE_URL ?? def?.baseUrl;
  if (!baseUrl) throw new Error(`LLM_BASE_URL is required for provider ${env.LLM_PROVIDER}`);
  if (!env.LLM_API_KEY) throw new Error(`LLM_API_KEY is required for provider ${env.LLM_PROVIDER}`);
  const [primary = ''] = modelChain(env, modelSpec);
  return {
    baseUrl,
    apiKey: env.LLM_API_KEY,
    model: primary,
    label,
    ...(def?.headers ? { headers: def.headers } : {}),
  };
}

export function hasModelCredentials(env: Env): boolean {
  if (env.LLM_PROVIDER === 'anthropic') {
    return Boolean(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }
  return Boolean(env.LLM_API_KEY);
}

export function healerModel(env: Env): ModelClient {
  if (env.LLM_PROVIDER === 'anthropic') {
    return anthropicModel({
      model: env.HEALER_MODEL,
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
    });
  }
  return openAICompatModel(
    compatOptions(env, env.HEALER_MODEL, 'healer'),
    modelChain(env, env.HEALER_MODEL).slice(1),
  );
}
