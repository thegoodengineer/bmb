-- RLS + grants. Roles are anon / authenticated; the claim function is auth.uid()
-- (verified in docs/INSFORGE_NOTES.md §A).
--
-- InsForge grants full DML on every new public table to BOTH anon and authenticated by
-- default (§E). We revoke that first and grant back exactly what the notes app needs, so
-- that F03 (revoke SELECT) is a real fault and anon has no table privileges at all.

alter table public.profiles enable row level security;
alter table public.notes enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.profiles, public.notes, public.audit_log from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.notes to authenticated;

create policy profiles_select_all on public.profiles
  for select to authenticated using (true);

-- Fault F01 replaces this policy with using (false).
create policy notes_select_own on public.notes
  for select to authenticated using (owner_id = (select auth.uid()));

create policy notes_insert_own on public.notes
  for insert to authenticated with check (owner_id = (select auth.uid()));

create policy notes_update_own on public.notes
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy notes_delete_own on public.notes
  for delete to authenticated using (owner_id = (select auth.uid()));
