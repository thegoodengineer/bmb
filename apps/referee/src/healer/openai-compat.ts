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
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        ...(opts.headers ?? {}),
      },
      body: JSON.stringify({ model: opts.model, ...body }),
    });
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text) as ChatResponse;
      if (json.error) throw new OpenAICompatError(errorText(json.error), res.status);
      return json;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryable = res.status === 429 || res.status >= 500;
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

export function openAICompatModel(opts: OpenAICompatOptions): ModelClient {
  return {
    model: opts.model,
    async create(turn) {
      const res = await chatCompletion(opts, {
        messages: toChatMessages(turn),
        tools: toChatTools(turn.tools),
        tool_choice: 'auto',
        max_tokens: turn.maxTokens,
        temperature: 0.2,
        // gpt-oss models spend output tokens on reasoning; low effort keeps turns cheap.
        ...(/gpt-oss/.test(opts.model) ? { reasoning_effort: 'low' } : {}),
      });
      return fromChatResponse(res, opts.model);
    },
  };
}
