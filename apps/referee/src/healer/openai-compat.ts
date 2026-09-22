import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelTurn } from './model.js';

/**
 * ModelClient over an OpenAI-compatible chat-completions endpoint (Groq, OpenRouter, …).
 *
 * The runner speaks the Anthropic message shape; this adapter converts the turn to
 * chat-completions format (system + user/assistant/tool messages, function tools) and
 * converts the reply back into an Anthropic.Message-shaped object (text, thinking and
 * tool_use blocks, stop_reason, usage). Nothing else in the healer changes.
 *
 * Free tiers rate-limit aggressively; 429s are retried with the server's Retry-After.
 */
export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra headers (OpenRouter likes HTTP-Referer / X-Title). */
  headers?: Record<string, string>;
  maxRetries?: number;
  label?: string;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning?: string | null; tool_calls?: ChatToolCall[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

let counter = 0;

/** Retry-After above this is treated as a spent quota, not a burst limit. */
const MAX_RETRY_AFTER_S = 90;

/** Per-attempt HTTP timeout. */
const REQUEST_TIMEOUT_MS = 90_000;

function blockText(block: Anthropic.ContentBlockParam | Anthropic.ContentBlock): string {
  if (block.type === 'text') return block.text;
  return '';
}

/** Anthropic messages → chat-completions messages. */
export function toChatMessages(turn: ModelTurn): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: turn.system }];
  for (const m of turn.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.map(blockText).filter(Boolean).join('\n');
      const calls = m.content
        .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
        .map<ChatToolCall>((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    // user: tool results become role=tool messages; plain text stays a user message
    const texts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const content =
          typeof b.content === 'string'
            ? b.content
            : (b.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
      } else if (b.type === 'text') {
        texts.push(b.text);
      }
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

export function toChatTools(tools: Anthropic.Tool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema,
    },
  }));
}

/** chat-completions reply → Anthropic.Message shape the runner understands. */
export function fromChatResponse(res: ChatResponse, model: string): Anthropic.Message {
  const choice = res.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Anthropic.ContentBlock[] = [];
  if (msg.reasoning?.trim()) {
    content.push({ type: 'thinking', thinking: msg.reasoning, signature: '' });
  }
  if (msg.content?.trim()) {
    content.push({ type: 'text', text: msg.content, citations: null });
  }
  for (const call of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = { _unparsable_arguments: call.function.arguments };
    }
    counter++;
    content.push({
      type: 'tool_use',
      id: call.id || `call_${counter}`,
      name: call.function.name,
      input,
    } as unknown as Anthropic.ToolUseBlock);
  }
  const finish = choice?.finish_reason;
  const stop_reason: Anthropic.Message['stop_reason'] =
    (msg.tool_calls?.length ?? 0) > 0 || finish === 'tool_calls'
      ? 'tool_use'
      : finish === 'length'
        ? 'max_tokens'
        : 'end_turn';
  return {
    id: res.id ?? `chatcmpl_${++counter}`,
    type: 'message',
    role: 'assistant',
    model: res.model ?? model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export class OpenAICompatError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** POST /chat/completions with retries on 429/5xx. Shared by the healer and the judge. */
export async function chatCompletion(
  opts: OpenAICompatOptions,
  body: Record<string, unknown>,
): Promise<ChatResponse> {
  const maxRetries = opts.maxRetries ?? 5;
  let attempt = 0;
  while (true) {
    attempt++;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify({ model: opts.model, ...body }),
        // A hung connection must never freeze the referee.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      if (attempt > maxRetries) {
        throw new OpenAICompatError(
          `${opts.label ?? 'llm'} request failed: ${e instanceof Error ? e.message : String(e)}`,
          0,
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** attempt)));
      continue;
    }
    if (res.ok) {
      const json = JSON.parse(text) as ChatResponse;
      if (json.error) throw new OpenAICompatError(errorText(json.error), res.status);
      return json;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryable = res.status === 429 || res.status >= 500;
    // A long Retry-After means a daily quota is spent: fail this round now rather than
    // freezing the referee (and the public queue) for minutes or hours.
    if (res.status === 429 && Number.isFinite(retryAfter) && retryAfter > MAX_RETRY_AFTER_S) {
      throw new OpenAICompatError(
        `${opts.label ?? 'llm'} quota exhausted, provider asks to wait ${Math.round(retryAfter)}s`,
        429,
        retryAfter * 1000,
      );
    }
    if (!retryable || attempt > maxRetries) {
      throw new OpenAICompatError(
        `${opts.label ?? 'llm'} ${res.status}: ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(60_000, 2000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function errorText(e: { message?: string } | string): string {
  return typeof e === 'string' ? e : (e.message ?? 'unknown error');
}

/** Models whose provider quota is spent, and when they may be tried again (epoch ms). */
const exhaustedUntil = new Map<string, number>();

function isQuotaExhausted(e: unknown): e is OpenAICompatError {
  return e instanceof OpenAICompatError && e.status === 429 && (e.retryAfterMs ?? 0) > 0;
}

/**
 * Try `models` in order, skipping any whose quota is known to be spent. Free tiers give
 * each model its own daily budget, so a chain multiplies what one key can serve. Every
 * response carries the model that actually answered (`res.model`), which the runner records.
 */
export async function chatWithFallback(
  opts: OpenAICompatOptions,
  models: string[],
  bodyFor: (model: string) => Record<string, unknown>,
): Promise<{ res: ChatResponse; model: string }> {
  const now = Date.now();
  const candidates = models.filter((m) => (exhaustedUntil.get(m) ?? 0) <= now);
  const chain = candidates.length ? candidates : models;
  let lastError: unknown;
  for (const model of chain) {
    try {
      const res = await chatCompletion({ ...opts, model }, bodyFor(model));
      return { res, model };
    } catch (e) {
      lastError = e;
      // Too large for this model's per-minute cap: the next model may have a bigger one.
      if (e instanceof OpenAICompatError && e.status === 413) continue;
      if (!isQuotaExhausted(e)) throw e;
      exhaustedUntil.set(model, Date.now() + (e.retryAfterMs ?? 60_000));
    }
  }
  throw lastError;
}

export function openAICompatModel(
  opts: OpenAICompatOptions,
  fallbacks: string[] = [],
): ModelClient {
  const models = [opts.model, ...fallbacks.filter((m) => m !== opts.model)];
  return {
    model: opts.model,
    async create(turn) {
      const { res, model } = await chatWithFallback(opts, models, (m) => ({
        messages: toChatMessages(turn),
        tools: toChatTools(turn.tools),
        tool_choice: 'auto',
        max_tokens: turn.maxTokens,
        temperature: 0.2,
        // gpt-oss models spend output tokens on reasoning; low effort keeps turns cheap.
        ...(/gpt-oss/.test(m) ? { reasoning_effort: 'low' } : {}),
      }));
      return fromChatResponse(res, model);
    },
  };
}
