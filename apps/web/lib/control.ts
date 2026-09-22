import { createClient, type InsForgeClient } from '@insforge/sdk';

/**
 * Anon client for the control project. Safe on the server and in the browser: the anon key
 * can only read the public views/events and call `enqueue_round` (RLS + grants in
 * control/migrations). There is no service key anywhere in this app.
 */
export function controlUrl(): string {
  const url = process.env.NEXT_PUBLIC_CONTROL_URL;
  if (!url) throw new Error('NEXT_PUBLIC_CONTROL_URL is not set');
  return url;
}

export function controlAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_CONTROL_ANON_KEY;
  if (!key) throw new Error('NEXT_PUBLIC_CONTROL_ANON_KEY is not set');
  return key;
}

let cached: InsForgeClient | undefined;

export function controlClient(): InsForgeClient {
  cached ??= createClient({ baseUrl: controlUrl(), anonKey: controlAnonKey() });
  return cached;
}

/** A `rounds_public` row (the columns anon may read). */
export interface PublicRound {
  id: string;
  created_at: string;
  attacker_handle: string | null;
  fault_ids: string[];
  combo_id: string | null;
  healer_config: string;
  status: string;
  attacked_at: string | null;
  diagnosed_at: string | null;
  healed_at: string | null;
  ended_at: string | null;
  diagnosis: Record<string, unknown> | null;
  judge: Record<string, unknown> | null;
  healed: boolean | null;
  judge_pass: boolean | null;
  unhealed_reason: string | null;
  ttd_ms: number | null;
  ttm_ms: number | null;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  attacker_points: number;
}

export interface PublicEvent {
  id: number;
  round_id: string;
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export async function fetchRecentRounds(limit = 30): Promise<PublicRound[]> {
  const { data, error } = await controlClient()
    .database.from('rounds_public')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as PublicRound[] | null) ?? [];
}

export async function fetchEvents(roundId: string, sinceId = 0): Promise<PublicEvent[]> {
  const { data, error } = await controlClient()
    .database.from('events')
    .select('*')
    .eq('round_id', roundId)
    .gt('id', sinceId)
    .order('id', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data as PublicEvent[] | null) ?? [];
}
