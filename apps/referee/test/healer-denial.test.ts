import { describe, expect, it } from 'vitest';
import { MemorySink } from '../src/events.js';
import { buildConfig } from '../src/healer/configs.js';
import { fakeMessage, fakeText, fakeToolUse, scriptedModel } from '../src/healer/model.js';
import { runHealer } from '../src/healer/runner.js';
import { HealerToolset, readSqlViolation, writeSqlViolation } from '../src/healer/tools.js';

/**
 * Negative tests (SPEC.md §11 Phase 3): the write gate and the SQL filters refuse before
 * anything reaches the CLI. No network: every scripted call below is denied or is the
 * diagnosis gate, so the toolset never spawns the CLI.
 */

const RED = [
  { name: 'P1' as const, ok: true, ms: 300 },
  { name: 'P2' as const, ok: false, ms: 200, error: 'expected 20 rows, got 0' },
  { name: 'P3' as const, ok: true, ms: 400 },
  { name: 'P4' as const, ok: false, ms: 200, error: 'note_count = 0, expected 25' },
  { name: 'P5' as const, ok: false, ms: 500, error: 'invoke summarize 404' },
  { name: 'P6' as const, ok: false, ms: 200, error: 'probe note #25 not visible' },
];

function makeToolset(sink: MemorySink) {
  return new HealerToolset({
    cwd: process.cwd(),
    probeStatus: async () => RED,
    sink,
  });
}

describe('write gate and SQL filters', () => {
  it('locks write tools until submit_diagnosis', async () => {
    const sink = new MemorySink();
    const tools = makeToolset(sink);
    const before = await tools.execute('db_execute', {
      sql: 'grant select on public.notes to authenticated',
    });
    expect(before.isError).toBe(true);
    expect(before.denied).toMatch(/locked until you call submit_diagnosis/);

    const gate = await tools.execute('submit_diagnosis', {
      component: 'notes select policy',
      mechanism: 'policy denies all rows',
      affected: ['P2', 'P4', 'P5', 'P6'],
      confidence: 0.8,
      reasoning: 'empty result with 200, other tables fine',
    });
    expect(gate.isError).toBe(false);
    expect(tools.isUnlocked).toBe(true);
    expect(sink.events.map((e) => e.kind)).toContain('diagnosis');
  });

  it('denies truncate, DML, other schemas and dangerous calls even after the gate', async () => {
    const sink = new MemorySink();
    const tools = makeToolset(sink);
    await tools.execute('submit_diagnosis', {
      component: 'x',
      mechanism: 'y',
      affected: [],
      confidence: 0.5,
      reasoning: 'z',
    });
    const cases: Array<[string, RegExp]> = [
      ['truncate notes', /accepts CREATE, ALTER, DROP/],
      ['drop table public.notes; truncate public.notes', /exactly one statement/],
      ['delete from public.audit_log', /accepts CREATE, ALTER, DROP/],
      ['drop table public.profiles', /profiles table must not be dropped/],
      ['alter table auth.users add column x int', /only the public schema/],
      [
        'create function public.f() returns int language sql security definer as $$ select 1 $$',
        /SECURITY DEFINER/,
      ],
      ['create extension citext', /extensions and schemas are off limits/],
    ];
    for (const [sql, why] of cases) {
      const r = await tools.execute('db_execute', { sql });
      expect(r.isError, sql).toBe(true);
      expect(r.denied, sql).toMatch(why);
    }
    const denied = sink.events.filter((e) => e.kind === 'tool_result' && e.payload.denied);
    expect(denied.length).toBe(cases.length);
  });

  it('treats a function body with semicolons as one statement', () => {
    const plpgsql = `create or replace function public.touch_updated_at() returns trigger
      language plpgsql as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$;`;
    expect(writeSqlViolation(plpgsql)).toBeUndefined();
    const tagged = `create function public.f() returns int language sql as $body$ select 1; $body$`;
    expect(writeSqlViolation(tagged)).toBeUndefined();
    const quoted = `comment on table public.notes is 'a; b; c'`;
    expect(writeSqlViolation(quoted)).toBeUndefined();
  });

  it('still denies dangerous calls hidden inside a function body', () => {
    const sneaky = `create function public.f() returns void language plpgsql as $$
      begin perform pg_sleep(10); end; $$`;
    expect(writeSqlViolation(sneaky)).toMatch(/pg_sleep/);
    const truncating = `create function public.g() returns void language plpgsql as $$
      begin truncate public.notes; end; $$`;
    expect(writeSqlViolation(truncating)).toMatch(/TRUNCATE/);
    const twoStatements = `create index a on public.notes(id); drop table public.notes`;
    expect(writeSqlViolation(twoStatements)).toMatch(/exactly one statement/);
  });

  it('db_query ignores keywords inside string literals', () => {
    expect(readSqlViolation(`select 'drop table notes; delete' as label`)).toBeUndefined();
    expect(readSqlViolation(`select * from pg_proc where prosrc like '%;%'`)).toBeUndefined();
  });

  it('db_query accepts only single read statements', () => {
    expect(readSqlViolation('select * from pg_policies')).toBeUndefined();
    expect(readSqlViolation('  EXPLAIN select 1')).toBeUndefined();
    expect(readSqlViolation('with x as (select 1) select * from x;')).toBeUndefined();
    expect(readSqlViolation('drop table notes')).toMatch(/only accepts SELECT/);
    expect(readSqlViolation('select 1; drop table notes')).toMatch(/exactly one statement/);
    expect(readSqlViolation('with d as (delete from notes returning 1) select * from d')).toMatch(
      /read-only/,
    );
  });

  it('db_execute allow-list accepts the reference fixes', () => {
    const fixes = [
      'create policy notes_select_own on public.notes for select to authenticated using (owner_id = (select auth.uid()))',
      'grant select on public.notes to authenticated',
      'create index notes_owner_created_idx on public.notes (owner_id, created_at desc)',
      'alter table public.notes rename column content to body',
      'drop trigger notes_block on public.notes',
      'alter table public.notes drop constraint notes_title_impossible',
      'create or replace function public.note_count() returns integer language sql security invoker stable as $$ select count(*)::int from public.notes where owner_id = (select auth.uid()) $$',
    ];
    for (const sql of fixes) expect(writeSqlViolation(sql), sql).toBeUndefined();
  });
});

describe('runner with a scripted model', () => {
  it('records the denial and ends when the model stops calling tools', async () => {
    const sink = new MemorySink();
    const tools = makeToolset(sink);
    const model = scriptedModel([
      fakeMessage([
        fakeText('Hypothesis A: policy. Hypothesis B: grants.'),
        fakeToolUse('db_execute', { sql: 'truncate notes' }),
      ]),
      fakeMessage([fakeText('Giving up.')], 'end_turn'),
    ]);
    const result = await runHealer({
      config: buildConfig('H3'),
      model,
      toolset: tools,
      sink,
      initialProbes: RED,
      oracle: async () => ({ healed: false, greenStreak: 0, artifacts: {}, reason: 'probes_red' }),
    });
    expect(result.outcome).toBe('gave_up');
    expect(result.toolCalls).toBe(1);
    const kinds = sink.events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['healer_thought', 'tool_call', 'tool_result', 'gave_up']),
    );
    const denial = sink.events.find((e) => e.kind === 'tool_result');
    expect(denial?.payload.denied).toMatch(/locked until/);
  });

  it('stops at the tool-call budget', async () => {
    const sink = new MemorySink();
    const tools = makeToolset(sink);
    const spam = Array.from({ length: 30 }, () =>
      fakeMessage([fakeToolUse('db_execute', { sql: 'drop index public.x' })]),
    );
    const result = await runHealer({
      config: { ...buildConfig('H3'), maxToolCalls: 5 },
      model: scriptedModel(spam),
      toolset: tools,
      sink,
      initialProbes: RED,
      oracle: async () => ({ healed: false, greenStreak: 0, artifacts: {}, reason: 'probes_red' }),
    });
    expect(result.outcome).toBe('budget_calls');
    expect(result.toolCalls).toBe(5);
  });

  it('ends at the wall clock even when a model call never returns', async () => {
    const sink = new MemorySink();
    const hung = { model: 'hung', create: () => new Promise<never>(() => {}) };
    const started = Date.now();
    const result = await runHealer({
      config: { ...buildConfig('H3'), maxWallClockMs: 300 },
      model: hung,
      toolset: makeToolset(sink),
      sink,
      initialProbes: RED,
      oracle: async () => ({ healed: false, greenStreak: 0, artifacts: {}, reason: 'probes_red' }),
    });
    expect(result.outcome).toBe('budget_time');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('H1 restricts the tool list and per-tool caps', async () => {
    const sink = new MemorySink();
    const cfg = buildConfig('H1');
    const tools = new HealerToolset({
      cwd: process.cwd(),
      probeStatus: async () => RED,
      sink,
      allowedTools: cfg.allowedTools,
      maxCallsPerTool: cfg.maxCallsPerTool,
    });
    expect(tools.definitions.map((t) => t.name)).not.toContain('db_policies');
    const r1 = await tools.execute('db_policies', {});
    expect(r1.denied).toMatch(/not available/);
    const p1 = await tools.execute('probe_status', {});
    expect(p1.isError).toBe(false);
    const p2 = await tools.execute('probe_status', {});
    expect(p2.denied).toMatch(/at most 1/);
  });
});
