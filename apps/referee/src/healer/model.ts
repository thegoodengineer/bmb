import Anthropic from '@anthropic-ai/sdk';

/**
 * The healer talks to its model through this interface so tests can script responses
 * (see test/healer-denial.test.ts) and the live runner uses the Anthropic SDK.
 */
export interface ModelTurn {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
}

export interface ModelClient {
  readonly model: string;
  create(turn: ModelTurn): Promise<Anthropic.Message>;
}

export interface AnthropicModelOptions {
  model: string;
  apiKey?: string;
  /** low | medium | high — the healer runs at medium by default (agentic, many short steps). */
  effort?: 'low' | 'medium' | 'high';
  temperature?: number;
}

export function anthropicModel(opts: AnthropicModelOptions): ModelClient {
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  return {
    model: opts.model,
    async create(turn) {
      return client.messages.create({
        model: opts.model,
        max_tokens: turn.maxTokens,
        system: turn.system,
        messages: turn.messages,
        tools: turn.tools,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: opts.effort ?? 'medium' },
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
    },
  };
}

/** A scripted model: returns the queued responses in order, then ends the turn. */
export function scriptedModel(responses: Anthropic.Message[], model = 'scripted'): ModelClient {
  const queue = [...responses];
  return {
    model,
    async create() {
      const next = queue.shift();
      if (next) return next;
      return fakeMessage([{ type: 'text', text: 'done', citations: null }], 'end_turn');
    },
  };
}

let fakeId = 0;

/** Build a Message the way the API would return it (enough for the runner). */
export function fakeMessage(
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message['stop_reason'] = 'tool_use',
): Anthropic.Message {
  fakeId++;
  return {
    id: `msg_fake_${fakeId}`,
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      speed: null,
    },
    container: null,
    context_management: null,
    stop_details: null,
  } as unknown as Anthropic.Message;
}

export function fakeToolUse(name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  fakeId++;
  return {
    type: 'tool_use',
    id: `toolu_fake_${fakeId}`,
    name,
    input,
  } as unknown as Anthropic.ToolUseBlock;
}

export function fakeText(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null };
}
