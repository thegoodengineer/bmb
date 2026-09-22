// summarize — the victim's ONE edge function (good version).
//
// POST { noteId } with the caller's JWT → { summary: first 120 chars of body, words: n }.
// Reads the note AS THE CALLER so RLS applies. 401 without a bearer token, 404 when the
// note is not visible. Deterministic on purpose (no AI call) so probe P5 is stable.
//
// Runtime: InsForge cloud edge functions (Deno Subhosting) — documented ESM form.
// Deploy:  npx @insforge/cli functions deploy summarize --file functions/summarize/index.ts
// Fault F04 redeploys this slug with a source that throws at module top level.

import { createClient } from 'npm:@insforge/sdk';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!token) return json({ error: 'missing bearer token' }, 401);

  let noteId: unknown;
  try {
    noteId = ((await req.json()) as { noteId?: unknown })?.noteId;
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  if (typeof noteId !== 'string' || noteId.length === 0) {
    return json({ error: 'noteId (string) is required' }, 400);
  }

  const client = createClient({
    baseUrl: Deno.env.get('INSFORGE_BASE_URL'),
    accessToken: token,
  });

  const { data, error, status } = await client.database
    .from('notes')
    .select('id, body')
    .eq('id', noteId)
    .maybeSingle();

  if (error) {
    const code = status === 401 ? 401 : status === 403 ? 403 : 500;
    return json({ error: error.message ?? 'query failed', code: error.code ?? null }, code);
  }
  if (!data) return json({ error: 'note not found' }, 404);

  const body = String((data as { body?: unknown }).body ?? '');
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return json({ summary: body.slice(0, 120), words }, 200);
}
