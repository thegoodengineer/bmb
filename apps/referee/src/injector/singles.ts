import { exists, scalar, sql } from './helpers.js';
import type { Injector } from './types.js';

/**
 * The ten single faults (SPEC.md §6.1), SQL-only ones. F04 (edge function) is in
 * functions.ts because it deploys code rather than running SQL.
 *
 * Artifact checks are deliberately about STATE, and deliberately tolerant of a healer that
 * fixes things a different-but-correct way (a differently named index, a rewritten predicate).
 */

const GOOD_SELECT_POLICY = `create policy notes_select_own on public.notes
  for select to authenticated using (owner_id = (select auth.uid()))`;

const GOOD_INDEX = `create index if not exists notes_owner_created_idx
  on public.notes (owner_id, created_at desc)`;

const GOOD_NOTE_COUNT = `create or replace function public.note_count() returns integer
language sql security invoker stable
set search_path = pg_catalog, public, pg_temp
as $$
  select count(*)::int from public.notes where owner_id = (select auth.uid());
$$;
revoke execute on function public.note_count() from public, anon;
grant execute on function public.note_count() to authenticated`;

const GOOD_TOUCH = `create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at()`;

/** F01 Lockout: select policy denies everything. */
export const F01: Injector = {
  id: 'F01',
  async inject(ctx) {
    await sql(
      ctx,
      `drop policy if exists notes_select_own on public.notes;
       create policy notes_select_own on public.notes for select to authenticated using (false)`,
    );
  },
  async referenceFix(ctx) {
    await sql(ctx, `drop policy if exists notes_select_own on public.notes; ${GOOD_SELECT_POLICY}`);
  },
  async artifactPresent(ctx) {
    // Present if a deny-all select policy is still there, OR no owner-scoped select policy
    // exists for authenticated. Adding a second permissive policy next to USING (false)
    // makes probes green but leaves the artifact: that is the reward-hacking guard.
    const denyAll = await exists(
      ctx,
      `select 1 from pg_policies where schemaname='public' and tablename='notes'
         and cmd='SELECT' and qual in ('false', '(false)')`,
    );
    if (denyAll) return true;
    // Roles: `TO authenticated` or the default `public` are both correct fixes; the
    // auth.uid() predicate already excludes anon (uid is null).
    const ownerScoped = await exists(
      ctx,
      `select 1 from pg_policies where schemaname='public' and tablename='notes'
         and cmd in ('SELECT', 'ALL')
         and ('authenticated' = any(roles) or 'public' = any(roles))
         and qual like '%owner_id%' and qual like '%auth.uid()%'`,
    );
    return !ownerScoped;
  },
};

/** F02 Molasses: composite index dropped. */
export const F02: Injector = {
  id: 'F02',
  async inject(ctx) {
    await sql(ctx, 'drop index if exists public.notes_owner_created_idx');
  },
  async referenceFix(ctx) {
    await sql(ctx, GOOD_INDEX);
  },
  async artifactPresent(ctx) {
    // Any btree index on notes leading with owner_id and including created_at counts as fixed.
    const ok = await exists(
      ctx,
      `select 1 from pg_indexes where schemaname='public' and tablename='notes'
         and indexdef ~* '\\(owner_id, created_at( desc)?\\)'`,
    );
    return !ok;
  },
};

/** F03 Revoked: SELECT privilege gone for authenticated. */
export const F03: Injector = {
  id: 'F03',
  async inject(ctx) {
    await sql(ctx, 'revoke select on public.notes from authenticated');
  },
  async referenceFix(ctx) {
    await sql(ctx, 'grant select on public.notes to authenticated');
  },
  async artifactPresent(ctx) {
    const has = await scalar<boolean | string>(
      ctx,
      `select has_table_privilege('authenticated', 'public.notes', 'select') as ok`,
    );
    return !(has === true || has === 't' || has === 'true');
  },
};

/** F05 Renamed: column body → content. */
export const F05: Injector = {
  id: 'F05',
  async inject(ctx) {
    await sql(ctx, 'alter table public.notes rename column body to content');
  },
  async referenceFix(ctx) {
    const hasContent = await exists(ctx, NOTES_COLUMN('content'));
    if (!hasContent) return;
    // A healer may have worked around the rename by adding a new `body` column (plain or
    // GENERATED from content). It holds no original data (DML is not allowed to the healer),
    // so drop it before renaming the real column back.
    if (await exists(ctx, NOTES_COLUMN('body'))) {
      await sql(ctx, 'alter table public.notes drop column body');
    }
    await sql(ctx, 'alter table public.notes rename column content to body');
  },
  async artifactPresent(ctx) {
    // The original column is still renamed, whatever else was added next to it. A new `body`
    // column beside `content` makes some probes pass but is a workaround, not a fix.
    if (await exists(ctx, NOTES_COLUMN('content'))) return true;
    return !(await exists(ctx, NOTES_COLUMN('body')));
  },
};

function NOTES_COLUMN(name: string): string {
  return `select 1 from information_schema.columns
           where table_schema='public' and table_name='notes' and column_name='${name}'`;
}

/** F06 Poison Pill: BEFORE INSERT trigger raises. */
export const F06: Injector = {
  id: 'F06',
  async inject(ctx) {
    await sql(
      ctx,
      `create or replace function public.bmb_block() returns trigger language plpgsql as $$
         begin raise exception 'nope'; end $$;
       drop trigger if exists notes_block on public.notes;
       create trigger notes_block before insert on public.notes
         for each row execute function public.bmb_block()`,
    );
  },
  async referenceFix(ctx) {
    await sql(
      ctx,
      `drop trigger if exists notes_block on public.notes;
       drop function if exists public.bmb_block()`,
    );
  },
  async artifactPresent(ctx) {
    // The app has no legitimate insert trigger on notes, so any BEFORE INSERT row trigger is it.
    return exists(
      ctx,
      `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='notes' and not t.tgisinternal
          and (t.tgtype & 4) <> 0 and (t.tgtype & 2) <> 0`,
    );
  },
};

/** F07 Vanished RPC: note_count() dropped. */
export const F07: Injector = {
  id: 'F07',
  async inject(ctx) {
    await sql(ctx, 'drop function if exists public.note_count()');
  },
  async referenceFix(ctx) {
    await sql(ctx, GOOD_NOTE_COUNT);
  },
  async artifactPresent(ctx) {
    const present = await exists(
      ctx,
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='note_count'`,
    );
    return !present;
  },
};

/**
 * F08 Impossible Rule: CHECK constraint no insert can satisfy. Added NOT VALID because a
 * plain ADD CONSTRAINT validates existing rows and fails ("violated by some row"); NOT VALID
 * still enforces the check on every new insert, which is the fault.
 */
export const F08: Injector = {
  id: 'F08',
  async inject(ctx) {
    await sql(
      ctx,
      `alter table public.notes drop constraint if exists notes_title_impossible;
       alter table public.notes add constraint notes_title_impossible check (length(title) < 1) not valid`,
    );
  },
  async referenceFix(ctx) {
    await sql(ctx, 'alter table public.notes drop constraint if exists notes_title_impossible');
  },
  async artifactPresent(ctx) {
    // The app defines no CHECK constraints on notes, so any CHECK constraint is the artifact.
    return exists(
      ctx,
      `select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='notes' and k.contype='c'`,
    );
  },
};

/** F09 Wrong Owner: note_count() counts everyone else's notes. Silent. */
export const F09: Injector = {
  id: 'F09',
  async inject(ctx) {
    await sql(
      ctx,
      `create or replace function public.note_count() returns integer
       language sql security invoker stable
       set search_path = pg_catalog, public, pg_temp
       as $$ select count(*)::int from public.notes where owner_id <> (select auth.uid()); $$`,
    );
  },
  async referenceFix(ctx) {
    await sql(ctx, GOOD_NOTE_COUNT);
  },
  async artifactPresent(ctx) {
    const def = await scalar<string>(
      ctx,
      `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='note_count'`,
    );
    if (!def) return true; // missing entirely: still not the working function
    // Also catch NOT (owner_id = ...) and IS DISTINCT FROM rewrites.
    return /owner_id\s*(<>|!=)|NOT\s*\(\s*owner_id\s*=|owner_id\s+IS\s+DISTINCT\s+FROM/.test(def);
  },
};

/** F10 Quiet Update: updated_at no longer maintained. Silent. */
export const F10: Injector = {
  id: 'F10',
  async inject(ctx) {
    await sql(ctx, 'drop trigger if exists notes_touch on public.notes');
  },
  async referenceFix(ctx) {
    await sql(ctx, GOOD_TOUCH);
  },
  async artifactPresent(ctx) {
    const present = await exists(
      ctx,
      `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname='public' and c.relname='notes' and not t.tgisinternal
          and (t.tgtype & 16) <> 0 and (t.tgtype & 2) <> 0`,
    );
    return !present;
  },
};
