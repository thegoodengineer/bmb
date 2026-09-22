-- Break My Backend victim schema. Deliberately boring: two app tables plus a log table for decoys.
-- Applied with: npx @insforge/cli db migrations up --all   (runs as project_admin, one transaction)

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique,
  created_at timestamptz not null default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The composite index P2 depends on. Fault F02 drops it.
create index notes_owner_created_idx on public.notes (owner_id, created_at desc);

-- Exists so decoys have somewhere harmless to write (D01 Log Storm).
create table public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  level text not null,
  message text not null
);
