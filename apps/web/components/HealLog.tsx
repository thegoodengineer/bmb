'use client';

import { useState } from 'react';
import type { PublicEvent, PublicRound } from '@/lib/control';
import { fmtMs, fmtTime } from '@/lib/format';
import { collapseProbes } from '@/lib/heal-log';

interface Props {
  round: PublicRound | undefined;
  events: PublicEvent[];
  previous: { round: PublicRound; events: PublicEvent[] } | undefined;
  live: 'realtime' | 'polling' | 'connecting';
}

function label(e: PublicEvent): { text: string; cls: string; detail?: string | undefined } {
  const p = e.payload;
  switch (e.kind) {
    case 'attack':
      return { text: 'attack launched', cls: 'text-red' };
    case 'probe': {
      const results = (p.results as { name: string; ok: boolean }[] | undefined) ?? [];
      const red = results.filter((r) => !r.ok).map((r) => r.name);
      return {
        text: red.length ? `probes  ${red.join(' ')} red` : 'probes  all green',
        cls: red.length ? 'text-red/80' : 'text-green/80',
      };
    }
    case 'healer_thought':
      return { text: String(p.text ?? ''), cls: 'text-fg-dim italic' };
    case 'tool_call':
      return {
        text: `${String(p.name)} ▸`,
        cls: 'text-fg',
        detail: JSON.stringify(p.input, null, 1),
      };
    case 'tool_result':
      return {
        text: p.denied
          ? `denied: ${String(p.denied)}`
          : `${String(p.name)} → ${p.ok ? 'ok' : 'error'} (${String(p.ms)}ms)`,
        cls: p.denied ? 'text-red' : 'text-fg-dim',
        detail: String(p.preview ?? ''),
      };
    case 'diagnosis':
      return {
        text: `diagnosis: ${String(p.component)} — ${String(p.mechanism)}`,
        cls: 'text-gold',
        detail: String(p.reasoning ?? ''),
      };
    case 'fix_applied':
      return {
        text: `fix via ${String(p.tool)}`,
        cls: 'text-fg',
        detail: String(p.sql ?? p.slug ?? ''),
      };
    case 'verify':
      return {
        text: p.healed
          ? 'oracle: healed'
          : `oracle: ${String(p.reason)} (green streak ${String(p.greenStreak)})`,
        cls: p.healed ? 'text-green' : 'text-fg-dim',
      };
    case 'healed':
      return { text: '✔ HEALED', cls: 'text-green font-semibold' };
    case 'gave_up':
      return { text: `✘ ${String(p.outcome ?? 'gave up')}`, cls: 'text-red font-semibold' };
    case 'judge':
      return {
        text: `judge: ${String(p.score)}/9 ${p.pass ? 'pass' : 'fail'}`,
        cls: p.pass ? 'text-green' : 'text-red',
        detail: Array.isArray(p.evidence)
          ? (p.evidence as string[]).map((s, i) => `${i + 1}. ${s}`).join('\n')
          : undefined,
      };
    case 'reset':
      return { text: 'reset', cls: 'text-fg-dim' };
    default:
      return { text: e.kind, cls: 'text-fg-dim' };
  }
}

function Line({ e, repeats = 1 }: { e: PublicEvent; repeats?: number }) {
  const [open, setOpen] = useState(false);
  const l = label(e);
  return (
    <div className="border-b border-line/40 py-1 last:border-0">
      <button
        type="button"
        className="flex w-full items-start gap-3 text-left"
        onClick={() => setOpen((o) => !o)}
        disabled={!l.detail}
      >
        <span className="shrink-0 text-fg-dim/60">{fmtTime(e.at)}</span>
        <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${l.cls}`}>
          {l.text}
          {repeats > 1 && <span className="text-fg-dim/50"> ×{repeats}</span>}
        </span>
        {l.detail && <span className="shrink-0 text-fg-dim/50">{open ? '▾' : '▸'}</span>}
      </button>
      {open && l.detail && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-bg p-2 text-[11px] text-fg-dim">
          {l.detail}
        </pre>
      )}
    </div>
  );
}

function RoundHeader({ round }: { round: PublicRound }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-fg-dim">
      <span className="text-fg">{round.fault_ids.join(' + ')}</span>
      <span>{round.attacker_handle ?? 'anonymous'}</span>
      <span>{round.healer_config}</span>
      <span>{round.status}</span>
      {round.ttd_ms !== null && <span>TTD {fmtMs(round.ttd_ms)}</span>}
      {round.ttm_ms !== null && <span>TTM {fmtMs(round.ttm_ms)}</span>}
    </div>
  );
}

export function HealLog({ round, events, previous, live }: Props) {
  const [showPrev, setShowPrev] = useState(false);
  return (
    <section className="flex min-h-[420px] flex-col gap-2 font-mono text-xs" aria-label="Heal log">
      <header className="flex items-center justify-between">
        <h2 className="text-sm tracking-widest text-fg-dim">HEAL LOG</h2>
        <span className="text-[11px] text-fg-dim/70">{live}</span>
      </header>
      <div className="flex-1 rounded-[6px] border border-line bg-bg-2 p-3">
        {round ? (
          <>
            <RoundHeader round={round} />
            <div className="mt-2">
              {events.length === 0 && <p className="text-fg-dim/60">waiting for the referee…</p>}
              {collapseProbes(events).map((r) => (
                <Line key={r.e.id} e={r.e} repeats={r.repeats} />
              ))}
            </div>
          </>
        ) : (
          <p className="text-fg-dim/60">No round yet. Pick a fault on the left.</p>
        )}
      </div>
      {previous && (
        <div className="rounded-[6px] border border-line/60 p-2">
          <button
            type="button"
            className="w-full text-left text-fg-dim"
            onClick={() => setShowPrev((s) => !s)}
          >
            {showPrev ? '▾' : '▸'} replay: previous round · {previous.round.fault_ids.join('+')} ·{' '}
            {previous.round.healed
              ? 'healed'
              : previous.round.healed === false
                ? 'unhealed'
                : previous.round.status}
          </button>
          {showPrev && (
            <div className="mt-2">
              {collapseProbes(previous.events).map((r) => (
                <Line key={r.e.id} e={r.e} repeats={r.repeats} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
