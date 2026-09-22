import type { ProbeResult } from '@bmb/shared';
import type { InsForgeClient } from '@insforge/sdk';
import type { Env } from './env.js';
import { anonClient, loginAs } from './victim/clients.js';
import { PROBE_NOTE_COUNT, probeNoteId } from './victim/seed.js';

/**
 * The synthetic-user probe suite (SPEC.md §5.6). This is the healer's "alert": the only
 * referee-provided signal it ever sees. It contains no fault ids, only what a user would see.
 *
 *  P1 login          token obtained
 *  P2 list_notes     200, exactly 20 rows, all owner_id = probe user, ms < P2_MAX_MS
 *  P3 create+delete  both succeed, created row round-trips title/body
 *  P4 rpc note_count integer >= 25
 *  P5 invoke summarize on a known note: 200, summary non-empty, words > 0
 *  P6 update_note    200 and updated_at advanced
 *
 * Probes run sequentially so one cycle is one coherent user session.
 */

type ProbeName = ProbeResult['name'];

interface Session {
  client: InsForgeClient;
  userId: string;
}

interface Note {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

function fail(name: ProbeName, ms: number, error: string): ProbeResult {
  return { name, ok: false, ms, error: error.slice(0, 500) };
}

async function timed(name: ProbeName, fn: () => Promise<string | undefined>): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const error = await fn();
    const ms = Date.now() - t0;
    return error === undefined ? { name, ok: true, ms } : fail(name, ms, error);
  } catch (e) {
    return fail(name, Date.now() - t0, e instanceof Error ? e.message : String(e));
  }
}

function describeError(e: unknown): string {
  if (!e) return 'unknown error';
  if (typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown; error?: unknown; statusCode?: unknown };
    const parts = [o.statusCode, o.code, o.message ?? o.error].filter((p) => p !== undefined);
    if (parts.length) return parts.map(String).join(' ');
  }
  return String(e);
}

/**
 * Untimed connection warm-up (DNS + TLS) so the first probe of a cycle measures the backend,
 * not the referee's cold socket. A real monitor keeps its connections warm too.
 */
async function warmUp(env: Env): Promise<void> {
  try {
    // Through the SDK so its own fetch/agent opens the connection, not the global one.
    await anonClient(env).auth.getCurrentUser();
  } catch {
    // The probes will report the failure with detail.
  }
}

export async function runProbeSuite(env: Env): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  let session: Session | undefined;

  await warmUp(env);

  results.push(
    await timed('P1', async () => {
      const s = await loginAs(env, env.PROBE_EMAIL, env.PROBE_PASSWORD);
      session = { client: s.client, userId: s.userId };
      return undefined;
    }),
  );

  const need = (): Session => {
    if (!session) throw new Error('no session (P1 failed)');
    return session;
  };

  results.push(
    await timed('P2', async () => {
      const { client, userId } = need();
      const list = async () => {
        const t0 = Date.now();
        const res = await client.database
          .from('notes')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(20);
        return { ...res, ms: Date.now() - t0 };
      };
      let attempt = await list();
      // One retry when only latency failed: the first request after any DDL pays PostgREST's
      // schema-cache reload (~1.5 s). A missing index is slow on every request, so it still trips.
      if (!attempt.error && attempt.ms >= env.P2_MAX_MS) attempt = await list();
      const { data, error, status, ms } = attempt;
      if (error) return `list_notes ${describeError(error)}`;
      if (status !== 200) return `list_notes status ${status}`;
      const rows = (data ?? []) as Note[];
      if (rows.length !== 20) return `expected 20 rows, got ${rows.length}`;
      const foreign = rows.filter((r) => r.owner_id !== userId).length;
      if (foreign > 0) return `${foreign} rows not owned by probe user`;
      const malformed = rows.find((r) => typeof r.title !== 'string' || typeof r.body !== 'string');
      if (malformed) return `row shape unexpected: keys ${Object.keys(malformed).join(',')}`;
      if (ms >= env.P2_MAX_MS) return `list_notes took ${ms}ms (limit ${env.P2_MAX_MS}ms)`;
      return undefined;
    }),
  );

  results.push(
    await timed('P3', async () => {
      const { client, userId } = need();
      const title = `probe-create ${Date.now()}`;
      const body = `round-trip body ${Math.random().toString(36).slice(2)}`;
      const ins = await client.database
        .from('notes')
        .insert([{ owner_id: userId, title, body }])
        .select('id, title, body')
        .single();
      if (ins.error) return `create_note ${describeError(ins.error)}`;
      const row = ins.data as Pick<Note, 'id' | 'title' | 'body'> | null;
      if (!row) return 'create_note returned no row';
      if (row.title !== title || row.body !== body) return 'created row did not round-trip';
      const del = await client.database.from('notes').delete().eq('id', row.id);
      if (del.error) return `delete_note ${describeError(del.error)}`;
      return undefined;
    }),
  );

  results.push(
    await timed('P4', async () => {
      const { client } = need();
      const { data, error } = await client.database.rpc('note_count');
      if (error) return `rpc note_count ${describeError(error)}`;
      if (typeof data !== 'number' || !Number.isInteger(data)) {
        return `note_count returned ${JSON.stringify(data)}`;
      }
      // Exact: the probe user owns exactly PROBE_NOTE_COUNT notes (P3 deletes what it creates,
      // reset removes strays). A wrong-owner count (F09) is huge, not an error, so >= would pass.
      if (data !== PROBE_NOTE_COUNT) return `note_count = ${data}, expected ${PROBE_NOTE_COUNT}`;
      return undefined;
    }),
  );

  results.push(
    await timed('P5', async () => {
      const { client } = need();
      const { data, error } = await client.functions.invoke<{ summary?: unknown; words?: unknown }>(
        'summarize',
        { body: { noteId: probeNoteId(1) } },
      );
      if (error) return `invoke summarize ${describeError(error)}`;
      if (typeof data?.summary !== 'string' || data.summary.length === 0) {
        return `summarize returned no summary: ${JSON.stringify(data).slice(0, 200)}`;
      }
      if (typeof data.words !== 'number' || data.words <= 0)
        return `summarize words = ${data.words}`;
      return undefined;
    }),
  );

  results.push(
    await timed('P6', async () => {
      const { client } = need();
      const id = probeNoteId(PROBE_NOTE_COUNT);
      const before = await client.database
        .from('notes')
        .select('updated_at')
        .eq('id', id)
        .maybeSingle();
      if (before.error) return `read before update ${describeError(before.error)}`;
      const prev = (before.data as Pick<Note, 'updated_at'> | null)?.updated_at;
      if (!prev) return 'probe note #25 not visible';
      const upd = await client.database
        .from('notes')
        .update({ title: `Probe note #${PROBE_NOTE_COUNT} (touched ${new Date().toISOString()})` })
        .eq('id', id)
        .select('updated_at')
        .single();
      if (upd.error) return `update_note ${describeError(upd.error)}`;
      const next = (upd.data as Pick<Note, 'updated_at'> | null)?.updated_at;
      if (!next) return 'update returned no row';
      if (new Date(next).getTime() <= new Date(prev).getTime()) {
        return `updated_at did not advance (${prev} -> ${next})`;
      }
      return undefined;
    }),
  );

  return results;
}

export function allGreen(results: ProbeResult[]): boolean {
  return results.length === 6 && results.every((r) => r.ok);
}

export function formatProbeLine(r: ProbeResult): string {
  const status = r.ok ? 'ok ' : 'RED';
  const ms = `${r.ms}ms`.padStart(7);
  return `${r.name} ${status} ${ms}${r.error ? `  ${r.error}` : ''}`;
}
