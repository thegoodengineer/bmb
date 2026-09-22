-- Public projections (SPEC.md §10). security_invoker so anon's column grants apply.

create view public.rounds_public with (security_invoker = true) as
  select id, created_at, attacker_handle, fault_ids, combo_id, healer_config, status,
         attacked_at, diagnosed_at, healed_at, ended_at, diagnosis, judge, healed, judge_pass,
         unhealed_reason, ttd_ms, ttm_ms, tool_calls, tokens_in, tokens_out, attacker_points
  from public.rounds;
grant select on public.rounds_public to anon;

-- Queue position for the attack panel: queued rounds oldest first.
create view public.queue_public with (security_invoker = true) as
  select id, created_at, attacker_handle, fault_ids, healer_config,
         row_number() over (order by created_at) as position
  from public.rounds where status = 'queued';
grant select on public.queue_public to anon;

-- Last 20 rounds the healer failed, excluding self-play (which has attacker_session = 'self-play').
-- The base table is read here with definer rights via a function so the session column is never exposed.
create or replace function public.wall_of_fame() returns table (
  id uuid, ended_at timestamptz, attacker_handle text, fault_ids text[], unhealed_reason text, attacker_points numeric
) language sql security definer stable set search_path = pg_catalog, public, pg_temp as $$
  select id, ended_at, attacker_handle, fault_ids, unhealed_reason, attacker_points
  from public.rounds
  where status = 'done' and healed = false and attacker_session <> 'self-play'
  order by ended_at desc limit 20
$$;
grant execute on function public.wall_of_fame() to anon;

-- Per-config aggregates over the last 200 done rounds (the web computes the richer breakdown
-- client-side from rounds_public; this view backs the headline numbers).
create view public.healer_stats with (security_invoker = true) as
  with recent as (
    select * from (
      select r.*, row_number() over (partition by healer_config order by ended_at desc) as rn
      from public.rounds r where status = 'done'
    ) x where rn <= 200
  )
  select healer_config,
         count(*)::int as rounds,
         avg(case when healed then 1 else 0 end)::numeric(5,4) as heal_rate,
         percentile_cont(0.5) within group (order by ttd_ms)::int as median_ttd_ms,
         percentile_cont(0.5) within group (order by ttm_ms) filter (where healed)::int as median_ttm_ms,
         avg(case when judge_pass then 1 else 0 end) filter (where judge_pass is not null)::numeric(5,4) as diag_pass_rate,
         avg(case when healed then 1 else 0 end) filter (where judge_pass = true)::numeric(5,4) as p_heal_given_diag,
         avg(case when healed then 1 else 0 end) filter (where judge_pass = false)::numeric(5,4) as p_heal_given_no_diag,
         avg(tool_calls)::numeric(8,2) as mean_tool_calls,
         avg(tokens_in + tokens_out)::numeric(12,1) as mean_tokens
  from recent group by healer_config;
grant select on public.healer_stats to anon;
