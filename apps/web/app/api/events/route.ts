import { NextResponse } from 'next/server';
import { fetchEvents } from '@/lib/control';

export const runtime = 'nodejs';

/** GET /api/events?round=<uuid>&since=<event id> — polling fallback for the heal log. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const round = url.searchParams.get('round') ?? '';
  const since = Number(url.searchParams.get('since') ?? '0') || 0;
  if (!/^[0-9a-f-]{36}$/.test(round))
    return NextResponse.json({ error: 'round required' }, { status: 400 });
  try {
    const events = await fetchEvents(round, since);
    return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 });
  }
}
