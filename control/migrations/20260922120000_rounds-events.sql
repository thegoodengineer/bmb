-- bmb-control: rounds, events, public read access, realtime publish (SPEC.md §10).
-- The web app holds only the anon key: it may INSERT queued rounds through the attack API's
-- server-side route (which uses the anon key + RLS below) and SELECT public views/events.
-- The referee writes with the project API key (project_admin).

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  attacker_session text not null,           -- hashed cookie; 'self-play' for idle rounds
  attacker_handle text,
  fault_ids text[] not null,                -- e.g. {F01} or {F02,D01}; decoy ids included
  combo_id text,
  healer_config text not null default 'H2', -- H1|H2|H3
  status text not null default 'queued',    -- queued|injecting|attacked|healing|healed|unhealed|invalid|resetting|done
  attacked_at timestamptz,
  diagnosed_at timestamptz,
  healed_at timestamptz,
  ended_at timestamptz,
  diagnosis jsonb,
  judge jsonb,
  healed boolean,
  judge_pass boolean,
  unhealed_reason text,
  ttd_ms integer,
  ttm_ms integer,
  tool_calls integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  attacker_points numeric not null default 0,
  constraint rounds_status_check check (status in
    ('queued','injecting','attacked','healing','healed','unhealed','invalid','resetting','done')),
  constraint rounds_config_check check (healer_config in ('H1','H2','H3')),
  constraint rounds_handle_check check (attacker_handle is null or attacker_handle ~ '^[a-z0-9_]{3,16}$')
);
create index rounds_status_created_idx on public.rounds (status, created_at);
create index rounds_created_idx on public.rounds (created_at desc);

create table public.events (
  id bigserial primary key,
  round_id uuid not null references public.rounds(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  payload jsonb not null
);
create index events_round_at_idx on public.events (round_id, at);

-- Privileges: nothing for anon/authenticated on base tables except what the policies below
-- need. Reads go through the views; the attack route inserts a queued round.
revoke all on public.rounds, public.events from anon, authenticated;
grant select, insert on public.rounds to anon;
grant select on public.events to anon;

alter table public.rounds enable row level security;
alter table public.events enable row level security;

-- Anyone may read rounds and events (the view below hides attacker_session).
create policy rounds_read_all on public.rounds for select to anon using (true);
create policy events_read_all on public.events for select to anon using (true);

-- The web app may enqueue a round: status must be 'queued', config H2 (public rounds),
-- everything the referee fills later must be null/default.
create policy rounds_enqueue on public.rounds for insert to anon with check (
  status = 'queued'
  and healer_config = 'H2'
  and attacked_at is null and diagnosed_at is null and healed_at is null and ended_at is null
  and diagnosis is null and judge is null and healed is null and judge_pass is null
  and tool_calls = 0 and tokens_in = 0 and tokens_out = 0 and attacker_points = 0
  and attacker_session <> 'self-play'
);

-- Column-level protection: anon may not read attacker_session even from the base table.
revoke select on public.rounds from anon;
grant select (id, created_at, attacker_handle, fault_ids, combo_id, healer_config, status,
  attacked_at, diagnosed_at, healed_at, ended_at, diagnosis, judge, healed, judge_pass,
  unhealed_reason, ttd_ms, ttm_ms, tool_calls, tokens_in, tokens_out, attacker_points)
  on public.rounds to anon;

-- Realtime: one channel per round plus a global feed. The web subscribes to `round:<id>` for
-- the heal log and `rounds:all` for status changes. Publishing happens from triggers.
insert into realtime.channels (pattern, description, enabled)
values ('round:%', 'per-round heal log events', true),
       ('rounds:all', 'round status changes', true)
on conflict (pattern) do update set enabled = excluded.enabled;

create or replace function public.publish_event() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform realtime.publish('round:' || new.round_id::text, new.kind,
    jsonb_build_object('id', new.id, 'round_id', new.round_id, 'at', new.at,
                       'kind', new.kind, 'payload', new.payload));
  return new;
end $$;

create trigger events_publish after insert on public.events
  for each row execute function public.publish_event();

create or replace function public.publish_round() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform realtime.publish('rounds:all', 'round',
    jsonb_build_object('id', new.id, 'status', new.status, 'fault_ids', new.fault_ids,
                       'attacker_handle', new.attacker_handle, 'healer_config', new.healer_config,
                       'healed', new.healed, 'judge_pass', new.judge_pass,
                       'ttm_ms', new.ttm_ms, 'ttd_ms', new.ttd_ms,
                       'attacker_points', new.attacker_points, 'created_at', new.created_at,
                       'ended_at', new.ended_at, 'unhealed_reason', new.unhealed_reason));
  return new;
end $$;

create trigger rounds_publish after insert or update on public.rounds
  for each row execute function public.publish_round();
