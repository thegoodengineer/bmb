import type Anthropic from '@anthropic-ai/sdk';
import type { ProbeResult } from '@bmb/shared';
import type { EventSink } from '../events.js';
import type { OracleVerdict } from '../oracle.js';
import type { HealerConfig } from './configs.js';
import type { ModelClient } from './model.js';
import type { HealerToolset } from './tools.js';

/**
 * The healer loop (SPEC.md §7.2, §7.5). One model turn → zero or more tool calls → repeat,
 * until the oracle says healed, the model stops calling tools, or a budget runs out.
 *
 * The runner never sees fault ids either: it receives probe results, a toolset, a model and
 * an oracle callback that returns a verdict without saying what the faults were.
 */
export type HealerOutcome = 'healed' | 'gave_up' | 'budget_calls' | 'budget_time' | 'error';

export interface HealerRunResult {
  outcome: HealerOutcome;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  firstDiagnosisAt: string | undefined;
  lastVerdict: OracleVerdict | undefined;
  error?: string;
  startedAt: string;
  endedAt: string;
}

export interface HealerRunOptions {
  config: HealerConfig;
  model: ModelClient;
  toolset: HealerToolset;
  sink: EventSink;
  /** The alert that opens the conversation. */
  initialProbes: ProbeResult[];
  /** Called after every tool call; the run ends as soon as it reports healed. */
  oracle: () => Promise<OracleVerdict>;
  maxTokensPerTurn?: number;
  /** Keep this many most-recent tool results verbatim; older ones become one-line stubs. */
  liveToolResults?: number;
}

/**
 * Collapse older tool results so the resent history stays small. Free tiers cap tokens per
 * minute, and every turn resends the whole conversation; the model keeps the last few
 * results in full and a one-line reminder of the rest.
 */
export function pruneHistory(
  messages: Anthropic.MessageParam[],
  keep: number,
): Anthropic.MessageParam[] {
  const positions: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'user' || typeof m.content === 'string') return;
    m.content.forEach((b, j) => {
      if (b.type === 'tool_result') positions.push(`${i}:${j}`);
    });
  });
  const stale = new Set(positions.slice(0, Math.max(0, positions.length - keep)));
  if (stale.size === 0) return messages;
  return messages.map((m, i) => {
    if (m.role !== 'user' || typeof m.content === 'string') return m;
    return {
      ...m,
      content: m.content.map((b, j) => {
        if (b.type !== 'tool_result' || !stale.has(`${i}:${j}`)) return b;
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        const head = text.slice(0, 160).replace(/\s+/g, ' ');
        return {
          ...b,
          content: `[earlier result, ${text.length} chars, ${b.is_error ? 'error' : 'ok'}: ${head}…]`,
        };
      }),
    };
  });
}

export function formatAlert(results: ProbeResult[]): string {
  const lines = results.map(
    (r) => `${r.name} ${r.ok ? 'ok' : 'FAIL'} ${r.ms}ms${r.error ? ` — ${r.error}` : ''}`,
  );
  return `Alert: the synthetic-user probe suite is red.\n\n${lines.join('\n')}\n\nInvestigate and repair. Call probe_status to see the current state at any time.`;
}

export async function runHealer(opts: HealerRunOptions): Promise<HealerRunResult> {
  const { config, model, toolset, sink } = opts;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: formatAlert(opts.initialProbes) },
  ];

  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let turns = 0;
  let lastVerdict: OracleVerdict | undefined;

  const finish = (outcome: HealerOutcome, error?: string): HealerRunResult => {
    const result: HealerRunResult = {
      outcome,
      toolCalls,
      tokensIn,
      tokensOut,
      turns,
      firstDiagnosisAt: toolset.firstDiagnosisAt,
      lastVerdict,
      startedAt,
      endedAt: new Date().toISOString(),
      ...(error !== undefined ? { error } : {}),
    };
    void sink.record(outcome === 'healed' ? 'healed' : 'gave_up', {
      outcome,
      toolCalls,
      tokensIn,
      tokensOut,
      turns,
      ...(error !== undefined ? { error } : {}),
    });
    return result;
  };

  while (true) {
    if (Date.now() - startedMs > config.maxWallClockMs) return finish('budget_time');

    let response: Anthropic.Message;
    turns++;
    const keep = opts.liveToolResults ?? 4;
    const call = (live: number) =>
      model.create({
        system: config.systemPrompt,
        messages: pruneHistory(messages, live),
        tools: toolset.definitions,
        maxTokens: opts.maxTokensPerTurn ?? 4096,
      });
    try {
      response = await call(keep);
    } catch (e) {
      // Request too large (free-tier token caps): keep only the newest result and retry once.
      const status = (e as { status?: number }).status;
      if (status === 413 && keep > 1) {
        try {
          response = await call(1);
        } catch (e2) {
          return finish('error', e2 instanceof Error ? e2.message : String(e2));
        }
      } else {
        return finish('error', e instanceof Error ? e.message : String(e));
      }
    }
    tokensIn += response.usage.input_tokens;
    tokensOut += response.usage.output_tokens;

    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        await sink.record('healer_thought', {
          text: block.text.trim().slice(0, 2000),
          turn: turns,
        });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        await sink.record('healer_thought', {
          text: block.thinking.trim().slice(0, 2000),
          turn: turns,
          summarized: true,
        });
      }
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') return finish('error', 'model refused');
    if (toolUses.length === 0) {
      if (response.stop_reason === 'max_tokens') {
        messages.push({ role: 'user', content: 'Continue. Use one tool call per step.' });
        continue;
      }
      // The model stopped calling tools: it believes it is done (or gave up).
      lastVerdict = await opts.oracle();
      return finish(lastVerdict.healed ? 'healed' : 'gave_up');
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (toolCalls >= config.maxToolCalls) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: 'denied: tool call budget exhausted',
          is_error: true,
        });
        continue;
      }
      toolCalls++;
      const outcome = await toolset.execute(use.name, use.input);
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }
    messages.push({ role: 'user', content: results });

    lastVerdict = await opts.oracle();
    await sink.record('verify', {
      healed: lastVerdict.healed,
      reason: lastVerdict.reason,
      greenStreak: lastVerdict.greenStreak,
      artifactsPresent: Object.entries(lastVerdict.artifacts).filter(([, p]) => p).length,
    });
    if (lastVerdict.healed) return finish('healed');
    if (toolCalls >= config.maxToolCalls) return finish('budget_calls');
  }
}
