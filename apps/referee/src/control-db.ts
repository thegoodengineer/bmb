import type { EventKind, FaultId, HealerConfigId, RoundStatus } from '@bmb/shared';
import { createAdminClient, type InsForgeClient } from '@insforge/sdk';
import type { Env } from './env.js';
import type { EventSink } from './events.js';

/**
 * The referee's view of bmb-control (rounds, events). Uses the control project's API key
 * through the SDK; the healer has no access to this module or these credentials.
 */
export interface RoundRow {
  id: string;
  created_at: string;
  attacker_session: string;
  attacker_handle: string | null;
  fault_ids: FaultId[];
  combo_id: string | null;
  healer_config: HealerConfigId;
  status: RoundStatus;
}

export class ControlDb {
  private readonly client: InsForgeClient;

  constructor(env: Env) {
    if (!env.CONTROL_URL || !env.CONTROL_API_KEY) {
      throw new Error('CONTROL_URL and CONTROL_API_KEY are required for the control project');
    }
    this.client = createAdminClient({ baseUrl: env.CONTROL_URL, apiKey: env.CONTROL_API_KEY });
  }

  /** Oldest queued round, or undefined. */
  async nextQueued(): Promise<RoundRow | undefined> {
    const { data, error } = await this.client.database
      .from('rounds')
      .select(
        'id, created_at, attacker_session, attacker_handle, fault_ids, combo_id, healer_config, status',
      )
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw new Error(`control: nextQueued ${error.message}`);
    return (data as RoundRow[] | null)?.[0];
  }

  async countByStatus(statuses: RoundStatus[]): Promise<number> {
    const { count, error } = await this.client.database
      .from('rounds')
      .select('id', { count: 'exact', head: true })
      .in('status', statuses);
    if (error) throw new Error(`control: count ${error.message}`);
    return count ?? 0;
  }

  /** Rounds that were mid-flight when the referee died: mark them invalid on boot. */
  async abandonStale(): Promise<number> {
    const { data, error } = await this.client.database
      .from('rounds')
      .update({
        status: 'invalid',
        unhealed_reason: 'referee restarted',
        ended_at: new Date().toISOString(),
      })
      .in('status', ['injecting', 'attacked', 'healing', 'healed', 'unhealed', 'resetting'])
      .select('id');
    if (error) throw new Error(`control: abandonStale ${error.message}`);
    return (data as unknown[] | null)?.length ?? 0;
  }

  async createSelfPlayRound(faultIds: FaultId[], config: HealerConfigId): Promise<RoundRow> {
    const { data, error } = await this.client.database
      .from('rounds')
      .insert([
        {
          attacker_session: 'self-play',
          attacker_handle: null,
          fault_ids: faultIds,
          healer_config: config,
          status: 'queued',
        },
      ])
      .select(
        'id, created_at, attacker_session, attacker_handle, fault_ids, combo_id, healer_config, status',
      )
      .single();
    if (error || !data) throw new Error(`control: createSelfPlayRound ${error?.message}`);
    return data as RoundRow;
  }

  async lastRoundEndedAt(): Promise<Date | undefined> {
    const { data, error } = await this.client.database
      .from('rounds')
      .select('ended_at, created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`control: lastRound ${error.message}`);
    const row = (data as { ended_at: string | null; created_at: string }[] | null)?.[0];
    if (!row) return undefined;
    return new Date(row.ended_at ?? row.created_at);
  }

  async updateRound(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.database.from('rounds').update(patch).eq('id', id);
    if (error) throw new Error(`control: updateRound ${error.message}`);
  }

  async setStatus(
    id: string,
    status: RoundStatus,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.updateRound(id, { status, ...extra });
  }

  async addEvent(
    roundId: string,
    kind: EventKind,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client.database
      .from('events')
      .insert([{ round_id: roundId, kind, payload }]);
    if (error) throw new Error(`control: addEvent ${error.message}`);
  }

  /** Recent done rounds for aggregates and the eval report (newest first). */
  async recentDone(limit = 200): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client.database
      .from('rounds')
      .select('*')
      .eq('status', 'done')
      .order('ended_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`control: recentDone ${error.message}`);
    return (data as Record<string, unknown>[] | null) ?? [];
  }

  sinkFor(roundId: string): EventSink {
    return {
      record: async (kind, payload) => {
        try {
          await this.addEvent(roundId, kind, payload);
        } catch (e) {
          console.error(
            `control: event write failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      },
    };
  }
}
