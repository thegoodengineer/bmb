/**
 * `pnpm --filter @bmb/referee eval --config H1,H2,H3 --faults all --repeats 3 [--out docs/EVAL_<date>.md]`
 *
 * Batch evaluation (SPEC.md §11 Phase 7). Runs every requested fault (singles, each single
 * with a decoy, combos) N times per healer config, judges each round, and writes a markdown
 * table: fault × config → heal rate, diag pass, median TTM, lucky-fix rate. Rounds are also
 * recorded in the control project when CONTROL_* are set, tagged attacker 'eval'.
 *
 * Needs ANTHROPIC_API_KEY. Runs one round at a time against the live victim.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  attackerPoints,
  type FaultId,
  faultsOfTier,
  getFault,
  type HealerConfigId,
  median,
  roundPoints,
} from '@bmb/shared';
import { ControlDb } from '../control-db.js';
import { loadEnv, REFEREE_ROOT } from '../env.js';
import { hasModelCredentials } from '../healer/provider.js';
import { type JudgeVerdict, judgeFromEnv, judgeRound } from '../judge.js';
import { type RoundResult, runRound } from '../round.js';

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const env = loadEnv();
if (!hasModelCredentials(env)) {
  console.error(
    `no model credentials for LLM_PROVIDER=${env.LLM_PROVIDER}: set ANTHROPIC_API_KEY or LLM_API_KEY`,
  );
  process.exit(2);
}
const configs = flag('--config', 'H2')
  .split(',')
  .map((s) => s.trim()) as HealerConfigId[];
const repeats = Number(flag('--repeats', '1'));
const faultsArg = flag('--faults', 'all');
const date = new Date().toISOString().slice(0, 10);
const out = path.resolve(REFEREE_ROOT, '../..', flag('--out', `docs/EVAL_${date}.md`));

function planFaults(): FaultId[][] {
  if (faultsArg !== 'all')
    return faultsArg.split(',').map((s) => s.split('+').map((x) => x.trim()) as FaultId[]);
  const singles = faultsOfTier('single').map((f) => [f.id]);
  const decoys = faultsOfTier('decoy');
  const withDecoy = faultsOfTier('single').map(
    (f, i) => [f.id, decoys[i % decoys.length]?.id] as FaultId[],
  );
  const combos = faultsOfTier('combo').map((f) => [f.id]);
  return [...singles, ...withDecoy, ...combos];
}

interface Row {
  faults: string;
  config: HealerConfigId;
  healed: boolean;
  judgePass: boolean;
  ttdMs: number | null;
  ttmMs: number | null;
  toolCalls: number;
  tokens: number;
  reason: string | undefined;
  judge: JudgeVerdict | undefined;
}

const rows: Row[] = [];
const judge = await judgeFromEnv(env);
let control: ControlDb | undefined;
try {
  control = new ControlDb(env);
} catch {
  control = undefined;
}

const plan = planFaults();
console.log(
  `eval: ${plan.length} fault sets × ${configs.length} configs × ${repeats} repeats = ${plan.length * configs.length * repeats} rounds → ${out}`,
);

for (const faultIds of plan) {
  for (const config of configs) {
    for (let rep = 1; rep <= repeats; rep++) {
      const label = `${faultIds.join('+')} ${config} #${rep}`;
      console.log(`\n=== ${label}`);
      let roundId: string | undefined;
      if (control) {
        try {
          const r = await control.createSelfPlayRound(faultIds, config);
          roundId = r.id;
          await control.updateRound(roundId, { attacker_session: 'eval', status: 'injecting' });
        } catch (e) {
          console.log(`  control unavailable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const sink = control && roundId ? control.sinkFor(roundId) : undefined;
      let result: RoundResult;
      try {
        result = await runRound({
          env,
          faultIds,
          configId: config,
          ...(sink ? { sink } : {}),
          log: (l) => console.log(`  ${l.slice(0, 160)}`),
        });
      } catch (e) {
        console.log(`  round crashed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const diagnosis = result.events.filter((e) => e.kind === 'diagnosis').at(-1)?.payload;
      const affected = (
        (result.events.find((e) => e.kind === 'probe' && e.payload.green === false)?.payload
          .results as { name: string; ok: boolean }[] | undefined) ?? []
      )
        .filter((r) => !r.ok)
        .map((r) => r.name);
      let verdict: JudgeVerdict | undefined;
      try {
        verdict = await judgeRound(judge, {
          faultIds,
          diagnosis: diagnosis
            ? {
                component: String(diagnosis.component),
                mechanism: String(diagnosis.mechanism),
                affected: (diagnosis.affected as string[]) ?? [],
                confidence: Number(diagnosis.confidence),
                reasoning: String(diagnosis.reasoning),
              }
            : undefined,
          affectedProbes: affected,
        });
      } catch (e) {
        console.log(`  judge failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const healed = result.status === 'healed';
      const row: Row = {
        faults: faultIds.join('+'),
        config,
        healed,
        judgePass: verdict?.pass ?? false,
        ttdMs: result.ttdMs ?? null,
        ttmMs: result.ttmMs ?? null,
        toolCalls: result.healer?.toolCalls ?? 0,
        tokens: (result.healer?.tokensIn ?? 0) + (result.healer?.tokensOut ?? 0),
        reason: result.unhealedReason,
        judge: verdict,
      };
      rows.push(row);
      console.log(
        `  → ${result.status} judge=${verdict ? `${verdict.score}/9` : '-'} ttd=${row.ttdMs ?? '-'} ttm=${row.ttmMs ?? '-'} calls=${row.toolCalls}`,
      );
      if (control && roundId) {
        const { points, hasDecoy } = roundPoints(faultIds);
        await control
          .updateRound(roundId, {
            status: 'done',
            ended_at: new Date().toISOString(),
            healed: result.status === 'invalid' ? null : healed,
            judge: verdict ?? null,
            judge_pass: verdict?.pass ?? null,
            diagnosis: diagnosis ?? null,
            unhealed_reason: result.unhealedReason ?? null,
            ttd_ms: row.ttdMs,
            ttm_ms: row.ttmMs,
            tool_calls: row.toolCalls,
            tokens_in: result.healer?.tokensIn ?? 0,
            tokens_out: result.healer?.tokensOut ?? 0,
            attacker_points: attackerPoints({
              points,
              hasDecoy,
              healed,
              judgePass: verdict?.pass ?? false,
            }),
          })
          .catch(() => {});
      }
      writeReport();
    }
  }
}
writeReport();
console.log(`\nwrote ${out}`);

function pct(n: number, d: number): string {
  return d === 0 ? '–' : `${Math.round((n / d) * 100)}%`;
}

function writeReport(): void {
  const groups = new Map<string, Row[]>();
  for (const r of rows)
    groups.set(`${r.faults}|${r.config}`, [...(groups.get(`${r.faults}|${r.config}`) ?? []), r]);
  const lines: string[] = [
    `# Evaluation ${date}`,
    '',
    `Healer model \`${env.HEALER_MODEL}\`, judge model \`${env.JUDGE_MODEL}\`, victim \`${env.VICTIM_URL}\`.`,
    `Configs: ${configs.join(', ')} · repeats: ${repeats} · rounds so far: ${rows.length}.`,
    '',
    '| fault | config | rounds | heal rate | diag pass | TTD p50 | TTM p50 | lucky fix | tool calls | tokens |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const [key, rs] of [...groups.entries()].sort()) {
    const [faults, config] = key.split('|');
    const healed = rs.filter((r) => r.healed);
    const diagFail = rs.filter((r) => !r.judgePass);
    const lucky = diagFail.filter((r) => r.healed);
    lines.push(
      `| ${faults} | ${config} | ${rs.length} | ${pct(healed.length, rs.length)} | ${pct(rs.filter((r) => r.judgePass).length, rs.length)} | ${fmt(median(rs.flatMap((r) => (r.ttdMs === null ? [] : [r.ttdMs]))))} | ${fmt(median(healed.flatMap((r) => (r.ttmMs === null ? [] : [r.ttmMs]))))} | ${diagFail.length ? pct(lucky.length, diagFail.length) : '–'} | ${(rs.reduce((s, r) => s + r.toolCalls, 0) / rs.length).toFixed(1)} | ${Math.round(rs.reduce((s, r) => s + r.tokens, 0) / rs.length)} |`,
    );
  }
  lines.push(
    '',
    '## Per config',
    '',
    '| config | rounds | heal rate | diag pass | TTM p50 | lucky fix |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const config of configs) {
    const rs = rows.filter((r) => r.config === config);
    const healed = rs.filter((r) => r.healed);
    const diagFail = rs.filter((r) => !r.judgePass);
    lines.push(
      `| ${config} | ${rs.length} | ${pct(healed.length, rs.length)} | ${pct(rs.filter((r) => r.judgePass).length, rs.length)} | ${fmt(median(healed.flatMap((r) => (r.ttmMs === null ? [] : [r.ttmMs]))))} | ${diagFail.length ? pct(diagFail.filter((r) => r.healed).length, diagFail.length) : '–'} |`,
    );
  }
  lines.push(
    '',
    '## Rounds',
    '',
    '| fault | config | outcome | judge | TTD | TTM | reason |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
  );
  for (const r of rows) {
    lines.push(
      `| ${r.faults} | ${r.config} | ${r.healed ? 'healed' : 'unhealed'} | ${r.judge ? `${r.judge.score}/9 ${r.judge.pass ? 'pass' : 'fail'}` : '–'} | ${fmt(r.ttdMs)} | ${fmt(r.ttmMs)} | ${r.reason ?? ''} |`,
    );
  }
  lines.push(
    '',
    `Fault names: ${[...new Set(rows.flatMap((r) => r.faults.split('+')))].map((id) => `${id} = ${getFault(id)?.name ?? '?'}`).join(', ')}.`,
    '',
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n'));
}

function fmt(ms: number | null): string {
  if (ms === null) return '–';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
