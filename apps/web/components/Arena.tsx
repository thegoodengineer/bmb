'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicFault } from '@/lib/catalog';
import { controlClient, type PublicEvent, type PublicRound } from '@/lib/control';
import { pillState } from '@/lib/format';
import { AttackPanel } from './AttackPanel';
import { HealLog } from './HealLog';
import { HowScoringWorks } from './HowScoringWorks';
import { Scoreboard } from './Scoreboard';
import { StatusPill } from './StatusPill';

interface Props {
  catalog: PublicFault[];
  initialRounds: PublicRound[];
  initialEvents: PublicEvent[];
}

const ACTIVE = new Set(['injecting', 'attacked', 'healing', 'healed', 'unhealed', 'resetting']);
const EVENT_KINDS = [
  'attack',
  'probe',
  'healer_thought',
  'tool_call',
  'tool_result',
  'diagnosis',
  'fix_applied',
  'verify',
  'healed',
  'gave_up',
  'reset',
  'judge',
];

/**
 * The single page's live state: rounds (newest first) and the events of the round being
 * shown. Realtime first (`rounds:all` + `round:<id>` channels), with a poll that always
 * runs underneath it: a dropped realtime message would otherwise leave a permanent hole in
 * the heal log. The poll is every 2 s while the socket is down and every 5 s while it is up.
 */
export function Arena({ catalog, initialRounds, initialEvents }: Props) {
  const [rounds, setRounds] = useState<PublicRound[]>(initialRounds);
  const [events, setEvents] = useState<PublicEvent[]>(initialEvents);
  const [prevEvents, setPrevEvents] = useState<PublicEvent[]>([]);
  const [live, setLive] = useState<'realtime' | 'polling' | 'connecting'>('connecting');
  const [myRoundId, setMyRoundId] = useState<string | null>(null);
  const subscribedRound = useRef<string | null>(null);

  const active = useMemo(() => rounds.find((r) => ACTIVE.has(r.status)), [rounds]);
  const shown = useMemo(
    () => active ?? rounds.find((r) => r.status === 'done') ?? rounds[0],
    [active, rounds],
  );
  const previous = useMemo(() => {
    if (!shown) return undefined;
    const p = rounds.find((r) => r.id !== shown.id && r.status === 'done');
    return p ? { round: p, events: prevEvents } : undefined;
  }, [rounds, shown, prevEvents]);

  // A new finished round is what the scoreboard needs to refetch on.
  const doneCount = useMemo(() => rounds.filter((r) => r.status === 'done').length, [rounds]);

  const queueAhead = useMemo(() => {
    if (!myRoundId) return null;
    const mine = rounds.find((r) => r.id === myRoundId);
    if (mine?.status !== 'queued') return null;
    return rounds.filter((r) => r.status === 'queued' && r.created_at < mine.created_at).length;
  }, [rounds, myRoundId]);

  const upsertRound = useCallback((r: PublicRound) => {
    setRounds((prev) => {
      const existing = prev.find((x) => x.id === r.id);
      // The poll resends unchanged rows every few seconds; keep the same array so nothing
      // downstream re-renders or refetches on them.
      if (existing && existing.status === r.status && existing.healed === r.healed) return prev;
      const next = prev.filter((x) => x.id !== r.id);
      next.push(r);
      next.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return next.slice(0, 30);
    });
  }, []);

  const appendEvent = useCallback((e: PublicEvent) => {
    setEvents((prev) =>
      prev.some((x) => x.id === e.id) ? prev : [...prev, e].sort((a, b) => a.id - b.id),
    );
  }, []);

  const shownId = shown?.id;
  const previousId = previous?.round.id;
  // Cursor for the reconciliation poll. Only a poll response moves it: a realtime message
  // can be dropped, and advancing past it would hide every event the drop left behind.
  const pollCursor = useRef(0);

  // Load events when the shown round changes.
  useEffect(() => {
    if (!shownId) return;
    let cancelled = false;
    pollCursor.current = 0;
    fetch(`/api/events?round=${shownId}`)
      .then((r) => r.json())
      .then((d: { events?: PublicEvent[] }) => {
        if (cancelled) return;
        const list = d.events ?? [];
        setEvents(list);
        pollCursor.current = list.at(-1)?.id ?? 0;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shownId]);

  useEffect(() => {
    if (!previousId) return;
    let cancelled = false;
    fetch(`/api/events?round=${previousId}`)
      .then((r) => r.json())
      .then((d: { events?: PublicEvent[] }) => {
        if (!cancelled) setPrevEvents(d.events ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [previousId]);

  // Realtime.
  useEffect(() => {
    const client = controlClient();
    const rt = client.realtime;
    let alive = true;
    const onRound = (msg: Record<string, unknown>) => {
      setRounds((prev) => {
        const existing = prev.find((r) => r.id === msg.id);
        const merged = { ...(existing ?? emptyRound(msg)), ...pickRoundFields(msg) } as PublicRound;
        const next = prev.filter((x) => x.id !== merged.id);
        next.push(merged);
        next.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return next.slice(0, 30);
      });
    };
    const onEvent = (msg: Record<string, unknown>) => {
      if (typeof msg.id !== 'number') return;
      appendEvent({
        id: msg.id,
        round_id: String(msg.round_id),
        at: String(msg.at),
        kind: String(msg.kind),
        payload: (msg.payload as Record<string, unknown>) ?? {},
      });
    };
    (async () => {
      try {
        await rt.connect();
        if (!alive) return;
        const sub = await rt.subscribe('rounds:all');
        if (!sub.ok) throw new Error(sub.error?.message ?? 'subscribe failed');
        rt.on('round', onRound);
        for (const k of EVENT_KINDS) rt.on(k, onEvent);
        rt.on('disconnect', () => setLive('polling'));
        rt.on('connect', () => setLive('realtime'));
        setLive('realtime');
      } catch {
        setLive('polling');
      }
    })();
    return () => {
      alive = false;
      try {
        rt.off('round', onRound);
        for (const k of EVENT_KINDS) rt.off(k, onEvent);
        rt.disconnect();
      } catch {}
    };
  }, [appendEvent]);

  // Subscribe to the shown round's channel.
  useEffect(() => {
    if (!shownId || live !== 'realtime') return;
    const rt = controlClient().realtime;
    const channel = `round:${shownId}`;
    if (subscribedRound.current === channel) return;
    if (subscribedRound.current) rt.unsubscribe(subscribedRound.current);
    subscribedRound.current = channel;
    void rt.subscribe(channel);
  }, [shownId, live]);

  // Reconciliation poll. Realtime is the fast path, but it can drop a message, so this runs
  // underneath it and refetches everything past the cursor.
  useEffect(() => {
    const t = setInterval(
      async () => {
        try {
          const r = (await (await fetch('/api/rounds')).json()) as { rounds?: PublicRound[] };
          if (r.rounds) for (const x of r.rounds) upsertRound(x);
          if (!shownId) return;
          const e = (await (
            await fetch(`/api/events?round=${shownId}&since=${pollCursor.current}`)
          ).json()) as { events?: PublicEvent[] };
          for (const x of e.events ?? []) appendEvent(x);
          const last = e.events?.at(-1)?.id;
          if (last && last > pollCursor.current) pollCursor.current = last;
        } catch {}
      },
      live === 'realtime' ? 5000 : 2000,
    );
    return () => clearInterval(t);
  }, [live, shownId, upsertRound, appendEvent]);

  const faultNames = useMemo(
    () => Object.fromEntries(catalog.map((f) => [f.id, f.name])),
    [catalog],
  );
  const pill = pillState(active?.status, active?.healed);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl tracking-tight text-fg">BREAK MY BACKEND</h1>
          <p className="text-sm text-fg-dim">
            Strangers break a real backend. An AI fixes it. Live.
          </p>
        </div>
        <StatusPill state={pill} />
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <AttackPanel
          catalog={catalog}
          queueAhead={queueAhead}
          onAttacked={(id) => setMyRoundId(id)}
        />
        <HealLog
          round={shown}
          events={events.filter((e) => e.round_id === shown?.id)}
          previous={previous}
          live={live}
        />
      </div>

      <Scoreboard refreshKey={doneCount} faultNames={faultNames} />

      <footer className="flex flex-wrap items-center gap-4 border-t border-line pt-4 font-mono text-xs text-fg-dim">
        <HowScoringWorks />
        <a className="hover:text-fg" href="https://github.com/thegoodengineer/bmb">
          github ▸
        </a>
        <span className="ml-auto">built on InsForge</span>
      </footer>
    </div>
  );
}

function pickRoundFields(msg: Record<string, unknown>): Partial<PublicRound> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'id',
    'status',
    'fault_ids',
    'attacker_handle',
    'healer_config',
    'healed',
    'judge_pass',
    'ttm_ms',
    'ttd_ms',
    'attacker_points',
    'created_at',
    'ended_at',
    'unhealed_reason',
  ]) {
    if (k in msg) out[k] = msg[k];
  }
  return out as Partial<PublicRound>;
}

function emptyRound(msg: Record<string, unknown>): PublicRound {
  return {
    id: String(msg.id),
    created_at: String(msg.created_at ?? new Date().toISOString()),
    attacker_handle: null,
    fault_ids: [],
    combo_id: null,
    healer_config: 'H2',
    status: 'queued',
    attacked_at: null,
    diagnosed_at: null,
    healed_at: null,
    ended_at: null,
    diagnosis: null,
    judge: null,
    healed: null,
    judge_pass: null,
    unhealed_reason: null,
    ttd_ms: null,
    ttm_ms: null,
    tool_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    attacker_points: 0,
  };
}
