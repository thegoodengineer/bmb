-- The one RPC and the one trigger. Both are fault targets:
--   F07 drops note_count(); F09 flips its predicate; F10 drops the notes_touch trigger.

create or replace function public.note_count() returns integer
language sql security invoker stable
set search_path = pg_catalog, public, pg_temp
as $$
  select count(*)::int from public.notes where owner_id = (select auth.uid());
$$;

revoke execute on function public.note_count() from public, anon;
grant execute on function public.note_count() to authenticated;

create or replace function public.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_touch
  before update on public.notes
  for each row execute function public.touch_updated_at();
