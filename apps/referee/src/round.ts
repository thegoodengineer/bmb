import { type FaultId, getFault, type HealerConfigId } from '@bmb/shared';
import type { Env } from './env.js';
import { type EventSink, MemorySink, MultiSink } from './events.js';
import { buildConfig } from './healer/configs.js';
import type { ModelClient } from './healer/model.js';
import { healerModel } from './healer/provider.js';
import { type HealerRunResult, runHealer } from './healer/runner.js';
import { HealerToolset } from './healer/tools.js';
import { injectorsForRound, makeContext } from './injector/index.js';
import { checkHealed, type OracleVerdict } from './oracle.js';
import { ProbeMonitor } from './probe-monitor.js';
import { resetVictim } from './reset.js';

/**
 * One round, end to end (SPEC.md §7.2):
 *
 *   inject → attacked (a scope probe red within 30 s) → healer runs → healed | unhealed
 *   → reference fixes if needed → reset
 *
 * This module is the only place that knows both the fault ids and the healer. It passes
 * the healer nothing but probe results, tools and an oracle callback.
 */
export interface RoundOptions {
  env: Env;
  faultIds: FaultId[];
  configId: HealerConfigId;
  sink?: EventSink;
  /** Injected in tests; defaults to the Anthropic model from env. */
  model?: ModelClient;
  /** Skip the final reset (the caller will do it). */
  skipReset?: boolean;
  log?: (line: string) => void;
}

export interface RoundResult {
  faultIds: FaultId[];
  configId: HealerConfigId;
  status: 'healed' | 'unhealed' | 'invalid';
  unhealedReason?: string;
  attackedAt?: string;
  diagnosedAt?: string;
  healedAt?: string;
  healer?: HealerRunResult;
  verdict?: OracleVerdict;
  events: MemorySink['events'];
  msToAttacked?: number;
  ttdMs?: number;
  ttmMs?: number;
}

const ATTACK_DEADLINE_MS = 30_000;

export async function runRound(opts: RoundOptions): Promise<RoundResult> {
  const { env, faultIds, configId } = opts;
  const log = opts.log ?? (() => {});
  const memory = new MemorySink((e) =>
    log(`${e.at.slice(11, 19)} ${e.kind} ${summarize(e.payload)}`),
  );
  const sink: EventSink = opts.sink ? new MultiSink([memory, opts.sink]) : memory;
  const ctx = makeContext(env, (cmd) => log(`  $ ${cmd.slice(0, 140)}`));
  const injectors = injectorsForRound(faultIds);
  const scope = new Set(faultIds.flatMap((id) => getFault(id)?.groundTruth.scope ?? []));

  const monitor = new ProbeMonitor(env, sink);
  const result: RoundResult = { faultIds, configId, status: 'invalid', events: memory.events };

  try {
    await sink.record('attack', { faults: faultIds, config: configId });
    for (const inj of injectors) await inj.inject(ctx);
    monitor.resetStreak();
    monitor.start(true);

    // attacked: at least one in-scope probe red within the deadline
    const injectedAt = Date.now();
    let attacked = false;
    while (Date.now() - injectedAt < ATTACK_DEADLINE_MS) {
      const results = await monitor.runNow();
      if (results.some((r) => !r.ok && scope.has(r.name))) {
        attacked = true;
        break;
      }
      await sleep(1500);
    }
    if (!attacked) {
      result.status = 'invalid';
      result.unhealedReason = 'injector did not produce a red scope probe within 30 s';
      return result;
    }
    const attackedMs = Date.now();
    result.attackedAt = new Date(attackedMs).toISOString();
    result.msToAttacked = attackedMs - injectedAt;

    const config = buildConfig(configId, {
      skill: env.HEALER_SKILL ?? (env.LLM_PROVIDER === 'anthropic' ? 'full' : 'compact'),
      wallClockMs: env.HEALER_WALL_CLOCK_MS,
    });
    // Free-tier providers cap tokens per minute; keep every turn small.
    const constrained = env.LLM_PROVIDER !== 'anthropic';
    const toolset = new HealerToolset({
      cwd: ctx.cwd,
      probeStatus: async () => monitor.latest,
      sink,
      allowedTools: config.allowedTools,
      maxCallsPerTool: config.maxCallsPerTool,
      ...(constrained ? { maxResultChars: 1800 } : {}),
    });
    const model = opts.model ?? healerModel(env);

    let healedAtMs: number | undefined;
    const oracle = async () => {
      const v = await checkHealed(ctx, monitor, faultIds);
      if (v.healed && healedAtMs === undefined) healedAtMs = Date.now();
      return v;
    };

    const healer = await runHealer({
      config,
      model,
      toolset,
      sink,
      initialProbes: monitor.latest,
      oracle,
      ...(constrained ? { liveToolResults: 2, maxTokensPerTurn: 1024 } : {}),
    });
    result.healer = healer;
    if (healer.lastVerdict) result.verdict = healer.lastVerdict;
    if (toolset.firstDiagnosisAt) {
      result.diagnosedAt = toolset.firstDiagnosisAt;
      result.ttdMs = new Date(toolset.firstDiagnosisAt).getTime() - attackedMs;
    }

    // Give the probes a last chance if the healer stopped just before the third green cycle.
    let verdict = healer.lastVerdict;
    if (!verdict?.healed && healer.outcome !== 'error') {
      for (let i = 0; i < 3 && !verdict?.healed; i++) {
        await monitor.runNow();
        verdict = await oracle();
      }
      if (verdict) result.verdict = verdict;
    }

    if (verdict?.healed) {
      result.status = 'healed';
      result.healedAt = new Date(healedAtMs ?? Date.now()).toISOString();
      result.ttmMs = (healedAtMs ?? Date.now()) - attackedMs;
    } else {
      result.status = 'unhealed';
      result.unhealedReason =
        verdict?.reason === 'artifact_present'
          ? 'artifact_present'
          : healer.outcome === 'error'
            ? `error: ${healer.error ?? 'unknown'}`
            : healer.outcome;
    }
    return result;
  } finally {
    monitor.stop();
    if (!opts.skipReset) {
      await sink.record('reset', { reason: result.status });
      await resetVictim(env, (cmd) => log(`  $ ${cmd.slice(0, 140)}`));
    }
  }
}

function summarize(payload: Record<string, unknown>): string {
  const s = JSON.stringify(payload);
  return s.length > 220 ? `${s.slice(0, 220)}…` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
