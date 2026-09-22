-- Server-enforced enqueue (SPEC.md §9.3, §9.4). The web app calls this RPC with the anon key;
-- cooldown, one queued round per session, and the global queue cap live here, not in the
-- (stateless, forgeable) web tier. Direct inserts by anon are removed.

alter table public.rounds add column attacker_ip text;   -- salted hash, never exposed

drop policy if exists rounds_enqueue on public.rounds;
revoke insert on public.rounds from anon;

create or replace function public.enqueue_round(
  p_fault_ids text[], p_handle text, p_session text, p_ip text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_last     timestamptz;
  v_queued   int;
  v_id       uuid;
  v_pos      int;
  v_wait     int;
begin
  if p_session is null or length(p_session) < 16 then
    raise exception 'BAD_SESSION';
  end if;
  if p_handle is not null and p_handle !~ '^[a-z0-9_]{3,16}$' then
    raise exception 'BAD_HANDLE';
  end if;
  if p_fault_ids is null or array_length(p_fault_ids, 1) not between 1 and 2 then
    raise exception 'BAD_FAULTS';
  end if;
  if p_fault_ids[1] !~ '^[FC]\d\d$' or (array_length(p_fault_ids, 1) = 2 and p_fault_ids[2] !~ '^D\d\d$') then
    raise exception 'BAD_FAULTS';
  end if;

  -- one attack per 3 minutes per session or per IP
  select max(created_at) into v_last
    from public.rounds
   where attacker_session <> 'self-play'
     and (attacker_session = p_session or (p_ip is not null and attacker_ip = p_ip));
  if v_last is not null and v_last > now() - interval '3 minutes' then
    v_wait := ceil(extract(epoch from (v_last + interval '3 minutes' - now())))::int;
    raise exception 'COOLDOWN:%', v_wait;
  end if;

  if exists (select 1 from public.rounds where status = 'queued' and attacker_session = p_session) then
    raise exception 'ALREADY_QUEUED';
  end if;

  select count(*) into v_queued from public.rounds where status = 'queued';
  if v_queued >= 10 then
    raise exception 'QUEUE_FULL';
  end if;

  insert into public.rounds (attacker_session, attacker_ip, attacker_handle, fault_ids, combo_id, healer_config, status)
  values (p_session, p_ip, p_handle, p_fault_ids,
          case when p_fault_ids[1] like 'C%' then p_fault_ids[1] end, 'H2', 'queued')
  returning id into v_id;

  select position into v_pos from public.queue_public where id = v_id;
  return jsonb_build_object('roundId', v_id, 'position', coalesce(v_pos, 1) - 1);
end $$;

revoke all on function public.enqueue_round(text[], text, text, text) from public;
grant execute on function public.enqueue_round(text[], text, text, text) to anon;
