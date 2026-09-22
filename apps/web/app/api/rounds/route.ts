import { NextResponse } from 'next/server';
import { fetchRecentRounds } from '@/lib/control';

export const runtime = 'nodejs';

/** GET /api/rounds — the 30 most recent rounds (polling fallback for status + queue). */
export async function GET(): Promise<Response> {
  try {
    const rounds = await fetchRecentRounds(30);
    return NextResponse.json({ rounds }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 });
  }
}
