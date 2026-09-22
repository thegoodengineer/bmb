import { aggregateRounds, type HealerStats, type ScoredRound } from '@bmb/shared';
import { NextResponse } from 'next/server';
import { controlClient } from '@/lib/control';

export const runtime = 'nodejs';

export interface WallEntry {
  id: string;
  ended_at: string;
  attacker_handle: string | null;
  fault_ids: string[];
  unhealed_reason: string | null;
  attacker_points: number;
}

export interface ScoreboardPayload {
  generatedAt: string;
  stats: Record<string, HealerStats>;
  wall: WallEntry[];
}

let cache: { at: number; body: ScoreboardPayload } | undefined;
const TTL_MS = 10_000;

/** GET /api/scoreboard — aggregates over the last 200 done rounds per config, cached 10 s. */
export async function GET(): Promise<Response> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.body, { headers: { 'Cache-Control': 'public, max-age=10' } });
  }
  const client = controlClient();
  const [rounds, wall] = await Promise.all([
    client.database
      .from('rounds_public')
      .select(
        'fault_ids, healer_config, status, healed, judge_pass, ttd_ms, ttm_ms, tool_calls, tokens_in, tokens_out',
      )
      .eq('status', 'done')
      .order('ended_at', { ascending: false })
      .limit(600),
    client.database.rpc('wall_of_fame'),
  ]);
  if (rounds.error) return NextResponse.json({ error: rounds.error.message }, { status: 502 });
  const rows = (rounds.data as ScoredRound[] | null) ?? [];
  const stats: Record<string, HealerStats> = {};
  for (const config of ['H1', 'H2', 'H3']) stats[config] = aggregateRounds(rows, config);
  const body: ScoreboardPayload = {
    generatedAt: new Date().toISOString(),
    stats,
    wall: ((wall.data as WallEntry[] | null) ?? []).filter((w) => w),
  };
  cache = { at: Date.now(), body };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'public, max-age=10' } });
}
