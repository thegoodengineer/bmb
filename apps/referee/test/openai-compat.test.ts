import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatWithFallback, fromChatResponse, toChatMessages } from '../src/healer/openai-compat.js';

/**
 * The OpenAI-compatible adapter without network: message conversion both ways, and the
 * quota fallback chain (a 429 with a long Retry-After moves to the next model and keeps
 * skipping the spent one).
 */

const opts = { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'a', label: 't' };

function reply(model: string, content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      model,
      choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }),
    { status: 200 },
  );
}

function quota(seconds: number): Response {
  return new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
    status: 429,
    headers: { 'retry-after': String(seconds) },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('message conversion', () => {
  it('maps tool calls and tool results to chat-completions and back', () => {
    const chat = toChatMessages({
      system: 'sys',
      tools: [],
      maxTokens: 10,
      messages: [
        { role: 'user', content: 'alert' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 't1', name: 'db_policies', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"policies":[]}' }],
        },
      ],
    });
    expect(chat.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(chat[2]?.tool_calls?.[0]?.function.name).toBe('db_policies');
    expect(chat[3]?.tool_call_id).toBe('t1');

    const msg = fromChatResponse(
      {
        model: 'm',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              reasoning: 'think',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'probe_status', arguments: '{}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      'm',
    );
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(msg.usage.input_tokens).toBe(5);
  });

  it('keeps a reasoning-only turn as a valid assistant message', () => {
    const chat = toChatMessages({
      system: 'sys',
      tools: [],
      maxTokens: 10,
      messages: [
        { role: 'user', content: 'alert' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: "Let's run the probes.", signature: '' }],
        },
        { role: 'user', content: 'continue' },
      ],
    });
    expect(chat.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(chat[2]?.content).toBe("Let's run the probes.");
    expect(chat[2]?.tool_calls).toBeUndefined();
  });
});

describe('quota fallback chain', () => {
  it('moves to the next model when a quota is spent and keeps skipping it', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const model = JSON.parse(init.body).model as string;
        calls.push(model);
        return model === 'primary' ? quota(2400) : reply(model);
      }),
    );
    const first = await chatWithFallback(opts, ['primary', 'backup'], () => ({ messages: [] }));
    expect(first.model).toBe('backup');
    const second = await chatWithFallback(opts, ['primary', 'backup'], () => ({ messages: [] }));
    expect(second.model).toBe('backup');
    expect(calls).toEqual(['primary', 'backup', 'backup']);
  });

  it('does not fall back on ordinary errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    );
    await expect(chatWithFallback(opts, ['x', 'y'], () => ({}))).rejects.toThrow(/400/);
  });
});
