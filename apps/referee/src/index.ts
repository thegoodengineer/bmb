/**
 * Referee main loop (SPEC.md §7.2, §9.3).
 *
 *  boot:  validate env → abandon stale rounds → reset the victim → require probes green
 *  loop:  take the oldest queued round (FIFO) → run it → judge → score → mark done
 *         when idle > 60 s and no self-play in the last 10 min → enqueue a self-play round
 *  idle:  probes every 15 s so the page's status pill stays live
 *
 * One round at a time, always. The healer is only ever started from runRound.
 */
import { attackerPoints, type FaultId, faultsOfTier, getFault, roundPoints } from '@bmb/shared';
import { ControlDb, type RoundRow } from './control-db.js';
import { loadEnv } from './env.js';
import { hasModelCredentials } from './healer/provider.js';
import { judgeFromEnv, judgeRound } from './judge.js';
import { appendMiss } from './misses.js';
import { ProbeMonitor } from './probe-monitor.js';
import { allGreen } from './probes.js';
import { resetVictim } from './reset.js';
import { runRound } from './round.js';

const IDLE_BEFORE_SELF_PLAY_MS = 60_000;
const selfPlayEveryMs = (e: { SELF_PLAY_EVERY_MIN: number }) => e.SELF_PLAY_EVERY_MIN * 60_000;
const POLL_MS = 3000;

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<void> {
  const env = loadEnv();
  if (!hasModelCredentials(env)) {
    throw new Error(
      `no model credentials for LLM_PROVIDER=${env.LLM_PROVIDER} (ANTHROPIC_API_KEY or LLM_API_KEY)`,
    );
  }
  const control = new ControlDb(env);
  const judge = await judgeFromEnv(env);

  log('boot: abandoning stale rounds');
  const abandoned = await control.abandonStale();
  if (abandoned) log(`boot: marked ${abandoned} stale round(s) invalid`);

  log('boot: resetting the victim');
  const reset = await resetVictim(env, (cmd) => log(`  $ ${cmd.slice(0, 120)}`));
  log(`boot: reset done in ${reset.ms} ms`);

  const idle = new ProbeMonitor(env);
  for (let i = 0; i < 5; i++) {
    const r = await idle.runNow();
    log(
      `boot: probes ${
        allGreen(r)
          ? 'green'
          : `RED ${r
              .filter((x) => !x.ok)
              .map((x) => `${x.name}:${x.error}`)
              .join(' | ')}`
      }`,
    );
    if (idle.greenStreak >= 2) break;
  }
  if (idle.greenStreak < 2) throw new Error('boot: victim is not green; refusing to accept rounds');
  idle.start(false);

  let lastSelfPlayAt = 0;
  let lastActivityAt = Date.now();

  while (true) {
    const next = await control.nextQueued().catch((e) => {
      log(`control poll failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });

    if (next) {
      idle.stop();
      await processRound(next);
      lastActivityAt = Date.now();
      idle.start(false);
      continue;
    }

    const now = Date.now();
    if (
      now - lastActivityAt > IDLE_BEFORE_SELF_PLAY_MS &&
      now - lastSelfPlayAt > selfPlayEveryMs(env)
    ) {
      const singles = faultsOfTier('single');
      const pick = singles[Math.floor(Math.random() * singles.length)];
      if (pick) {
        lastSelfPlayAt = now;
        log(`idle: enqueueing self-play round ${pick.id}`);
        await control
          .createSelfPlayRound([pick.id], 'H2')
          .catch((e) => log(`self-play enqueue failed: ${e}`));
      }
    }
    await sleep(POLL_MS);
  }

  async function processRound(row: RoundRow): Promise<void> {
    const faultIds = row.fault_ids.filter((id) => getFault(id)) as FaultId[];
    if (faultIds.length === 0) {
      await control.setStatus(row.id, 'invalid', {
        unhealed_reason: 'unknown fault ids',
        ended_at: new Date().toISOString(),
      });
      return;
    }
    log(
      `round ${row.id}: ${faultIds.join('+')} config=${row.healer_config} attacker=${row.attacker_handle ?? row.attacker_session.slice(0, 8)}`,
    );
    await control.setStatus(row.id, 'injecting');
    const sink = control.sinkFor(row.id);

    let statusPushed: string | undefined;
    const result = await runRound({
      env,
      faultIds,
      configId: row.healer_config,
      sink: {
        record: async (kind, payload) => {
          await sink.record(kind, payload);
          // First red probe after injection: the round is under attack.
          if (kind === 'probe' && payload.green === false && statusPushed === 'injecting') {
            statusPushed = 'attacked';
            await control
              .setStatus(row.id, 'attacked', { attacked_at: new Date().toISOString() })
              .catch(() => {});
            return;
          }
          // Mirror lifecycle transitions onto the round row so the status pill is live.
          const transition =
            kind === 'attack'
              ? 'injecting'
              : kind === 'diagnosis' || kind === 'tool_call'
                ? 'healing'
                : kind === 'healed'
                  ? 'healed'
                  : kind === 'gave_up'
                    ? 'unhealed'
                    : kind === 'reset'
                      ? 'resetting'
                      : undefined;
          if (transition && transition !== statusPushed) {
            statusPushed = transition;
            await control.setStatus(row.id, transition).catch(() => {});
          }
        },
      },
      log: (line) => log(`  ${line}`),
    });

    if (result.attackedAt)
      await control.updateRound(row.id, { attacked_at: result.attackedAt }).catch(() => {});

    const lastDiagnosis = result.events.filter((e) => e.kind === 'diagnosis').at(-1)?.payload;
    const attackProbe = result.events.find(
      (e) => e.kind === 'probe' && (e.payload.green as boolean) === false,
    );
    const affectedProbes = (
      (attackProbe?.payload.results as { name: string; ok: boolean }[] | undefined) ?? []
    )
      .filter((r) => !r.ok)
      .map((r) => r.name);

    let judgeVerdict: Awaited<ReturnType<typeof judgeRound>> | undefined;
    if (result.status !== 'invalid') {
      try {
        judgeVerdict = await judgeRound(judge, {
          faultIds,
          diagnosis: lastDiagnosis ? stripDiagnosis(lastDiagnosis) : undefined,
          affectedProbes,
        });
        await sink.record('judge', { ...judgeVerdict });
      } catch (e) {
        log(`judge failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const healed = result.status === 'healed';
    const { points, hasDecoy } = roundPoints(faultIds);
    const judgePass = judgeVerdict?.pass ?? false;
    const score =
      result.status === 'invalid' ? 0 : attackerPoints({ points, hasDecoy, healed, judgePass });

    // Invalid rounds (injector or provider failure) stay 'invalid' so every aggregate and the
    // wall of fame, which read 'done' rounds only, exclude them.
    await control.updateRound(row.id, {
      status: result.status === 'invalid' ? 'invalid' : 'done',
      ended_at: new Date().toISOString(),
      healed: result.status === 'invalid' ? null : healed,
      healed_at: result.healedAt ?? null,
      diagnosed_at: result.diagnosedAt ?? null,
      diagnosis: lastDiagnosis ?? null,
      judge: judgeVerdict ?? null,
      judge_pass: judgeVerdict ? judgeVerdict.pass : null,
      unhealed_reason: result.unhealedReason ?? null,
      ttd_ms: result.ttdMs ?? null,
      ttm_ms: result.ttmMs ?? null,
      tool_calls: result.healer?.toolCalls ?? 0,
      tokens_in: result.healer?.tokensIn ?? 0,
      tokens_out: result.healer?.tokensOut ?? 0,
      attacker_points: score,
    });
    log(
      `round ${row.id}: ${result.status} ttd=${result.ttdMs ?? '-'}ms ttm=${result.ttmMs ?? '-'}ms judge=${judgeVerdict ? `${judgeVerdict.score}/9 ${judgeVerdict.pass ? 'pass' : 'fail'}` : '-'} points=${score}`,
    );

    if (result.status === 'unhealed' || (judgeVerdict && !judgeVerdict.pass)) {
      await appendMiss({
        roundId: row.id,
        faultIds,
        configId: row.healer_config,
        result,
        judge: judgeVerdict,
        diagnosis: lastDiagnosis,
      }).catch((e) => log(`misses log failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

function stripDiagnosis(p: Record<string, unknown>) {
  return {
    component: String(p.component ?? ''),
    mechanism: String(p.mechanism ?? ''),
    affected: Array.isArray(p.affected) ? (p.affected as string[]) : [],
    confidence: Number(p.confidence ?? 0),
    reasoning: String(p.reasoning ?? ''),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
