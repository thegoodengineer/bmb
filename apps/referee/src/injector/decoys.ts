import { deployLegacyPing, legacyPingPresent, removeLegacyPing } from './functions.js';
import { exists, sql } from './helpers.js';
import type { Injector } from './types.js';

/**
 * Decoys (SPEC.md §6.2): harmless noise. No probe may go red because of one; the test
 * suite proves that by injecting each decoy alone and requiring green ×3.
 *
 * `referenceFix` here means "clean up"; decoys are excluded from the healed oracle and
 * removed by the between-round reset.
 */

const LOG_STORM_MESSAGE = 'deprecated call: /v1/legacy';

/** D01 Log Storm: 500 warn rows over the last 10 minutes + a noisy second function. */
export const D01: Injector = {
  id: 'D01',
  async inject(ctx) {
    await sql(
      ctx,
      `insert into public.audit_log (at, level, message)
       select now() - (random() * interval '10 minutes'), 'warn', '${LOG_STORM_MESSAGE}'
       from generate_series(1, 500)`,
    );
    await deployLegacyPing(ctx);
  },
  async referenceFix(ctx) {
    await sql(ctx, `delete from public.audit_log where message = '${LOG_STORM_MESSAGE}'`);
    await removeLegacyPing(ctx);
  },
  async artifactPresent(ctx) {
    const rows = await exists(
      ctx,
      `select 1 from public.audit_log where message = '${LOG_STORM_MESSAGE}'`,
    );
    return rows || (await legacyPingPresent(ctx));
  },
};

/** D02 Bloat: an unindexed, RLS-less copy of (part of) notes. */
export const D02: Injector = {
  id: 'D02',
  async inject(ctx) {
    await sql(
      ctx,
      `drop table if exists public.scratch_export;
       create table public.scratch_export as select * from public.notes limit 5000`,
    );
  },
  async referenceFix(ctx) {
    await sql(ctx, 'drop table if exists public.scratch_export');
  },
  async artifactPresent(ctx) {
    return exists(
      ctx,
      `select 1 from information_schema.tables where table_schema='public' and table_name='scratch_export'`,
    );
  },
};

/** D03 Slow Neighbor: a deliberately slow function, called once so it shows in stats. */
export const D03: Injector = {
  id: 'D03',
  async inject(ctx) {
    await sql(
      ctx,
      `create or replace function public.report_slow() returns integer language sql volatile
       as $$ select 1 from pg_sleep(1.5) $$;
       grant execute on function public.report_slow() to authenticated`,
    );
    await sql(ctx, 'select public.report_slow()');
  },
  async referenceFix(ctx) {
    await sql(ctx, 'drop function if exists public.report_slow()');
  },
  async artifactPresent(ctx) {
    return exists(
      ctx,
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='report_slow'`,
    );
  },
};

/** D04 Extra Policy: a permissive insert policy on profiles nobody uses. */
export const D04: Injector = {
  id: 'D04',
  async inject(ctx) {
    await sql(
      ctx,
      `drop policy if exists profiles_insert_any on public.profiles;
       create policy profiles_insert_any on public.profiles for insert to authenticated with check (true)`,
    );
  },
  async referenceFix(ctx) {
    await sql(ctx, 'drop policy if exists profiles_insert_any on public.profiles');
  },
  async artifactPresent(ctx) {
    return exists(
      ctx,
      `select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_insert_any'`,
    );
  },
};
