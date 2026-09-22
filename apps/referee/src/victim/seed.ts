import { createHash } from 'node:crypto';
import { type Env, victimDir } from '../env.js';
import { dbQuery } from '../insforge-cli.js';
import { adminClient, loginAs } from './clients.js';

/**
 * Idempotent seed for the victim. Safe to run on every referee boot and after every reset:
 *  - two auth users (probe, filler) created through the admin SDK with autoConfirm
 *  - their profiles rows
 *  - 25 probe-owned notes with DETERMINISTIC ids (md5-derived uuids) so probes can address
 *    a known note without listing first
 *  - FILLER_NOTES filler-owned notes, topped up to the target count, so the composite index
 *    on (owner_id, created_at) actually matters for P2 latency (fault F02)
 */

export const PROBE_NOTE_COUNT = 25;

/** Stable uuid for probe note i (1-based): md5('bmb-probe-note-<i>') laid out as a uuid. */
export function probeNoteId(i: number): string {
  const hex = createHash('md5').update(`bmb-probe-note-${i}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';

export interface SeedReport {
  probeUserId: string;
  fillerUserId: string;
  probeNotes: number;
  fillerNotes: number;
  fillerInserted: number;
  ms: number;
}

/** Create the user if missing (admin signUp with autoConfirm), else sign in; return its id. */
export async function ensureUser(env: Env, email: string, password: string): Promise<string> {
  const admin = adminClient(env);
  const { data, error } = await admin.auth.signUp({ email, password, autoConfirm: true });
  if (!error && data?.user?.id) return data.user.id;
  // Most likely "already exists": prove the password still works and get the id.
  const session = await loginAs(env, email, password);
  return session.userId;
}

export async function seedVictim(env: Env): Promise<SeedReport> {
  const started = Date.now();
  const cwd = victimDir(env);
  const sqlOpts = { cwd, timeoutMs: 300_000 };

  const probeUserId = await ensureUser(env, env.PROBE_EMAIL, env.PROBE_PASSWORD);
  const fillerUserId = await ensureUser(env, env.FILLER_EMAIL, env.FILLER_PASSWORD);

  await dbQuery(
    `insert into public.profiles (id, handle) values
       ('${probeUserId}', 'probe'), ('${fillerUserId}', 'filler')
     on conflict (id) do nothing`,
    sqlOpts,
  );

  // Probe notes: deterministic ids, bodies 200–800 chars, created_at spread over the past.
  await dbQuery(
    `insert into public.notes (id, owner_id, title, body, created_at, updated_at)
     select md5('bmb-probe-note-' || i)::uuid, '${probeUserId}', 'Probe note #' || i,
            substr(repeat('${LOREM}', 8), 1, 200 + ((i * 37) % 600)),
            now() - (i || ' hours')::interval, now() - (i || ' hours')::interval
     from generate_series(1, ${PROBE_NOTE_COUNT}) i
     on conflict (id) do nothing`,
    sqlOpts,
  );

  // Filler notes: top up to FILLER_NOTES in chunks so no single statement runs too long.
  const target = env.FILLER_NOTES;
  const countRows = await dbQuery<{ n: number }>(
    `select count(*)::int as n from public.notes where owner_id = '${fillerUserId}'`,
    sqlOpts,
  );
  const existing = countRows[0]?.n ?? 0;
  let inserted = 0;
  const CHUNK = 20_000;
  for (let have = existing; have < target; have += CHUNK) {
    const batch = Math.min(CHUNK, target - have);
    await dbQuery(
      `insert into public.notes (owner_id, title, body, created_at, updated_at)
       select '${fillerUserId}', 'Filler ' || i,
              substr(repeat('${LOREM}', 2), 1, 100 + (i % 120)),
              now() - (i || ' seconds')::interval, now() - (i || ' seconds')::interval
       from generate_series(${have + 1}, ${have + batch}) i`,
      sqlOpts,
    );
    inserted += batch;
  }

  // Fresh planner statistics: right after a bulk insert the planner may still think the
  // table is tiny and pick a sequential scan, which made the first P2 cycle take 1.5 s.
  await dbQuery('analyze public.notes', sqlOpts);

  const counts = await dbQuery<{ owner_id: string; n: number }>(
    `select owner_id, count(*)::int as n from public.notes group by owner_id`,
    sqlOpts,
  );
  const countFor = (id: string) => counts.find((c) => c.owner_id === id)?.n ?? 0;

  return {
    probeUserId,
    fillerUserId,
    probeNotes: countFor(probeUserId),
    fillerNotes: countFor(fillerUserId),
    fillerInserted: inserted,
    ms: Date.now() - started,
  };
}
