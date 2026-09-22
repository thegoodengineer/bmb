'use client';

import type { HealerStats } from '@bmb/shared';
import { useEffect, useState } from 'react';
import type { ScoreboardPayload, WallEntry } from '@/app/api/scoreboard/route';
import { fmtMs, fmtPct } from '@/lib/format';
import { WallOfFame } from './WallOfFame';

function Bar({ v }: { v: number | null }) {
  const pct = v === null ? 0 : Math.round(v * 100);
  return (
    <span className="inline-block h-1.5 w-16 overflow-hidden rounded-[3px] bg-line align-middle">
      <span className="block h-full bg-gold-dim" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Scoreboard({
  refreshKey,
  faultNames,
}: {
  refreshKey: number;
  faultNames: Record<string, string>;
}) {
  const [data, setData] = useState<ScoreboardPayload | null>(null);
  const [byFault, setByFault] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/scoreboard?v=${refreshKey}`)
      .then((r) => r.json())
      .then((d: ScoreboardPayload) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const h2: HealerStats | undefined = data?.stats.H2;
  const wall: WallEntry[] = data?.wall ?? [];

  return (
    <section className="flex flex-col gap-4" aria-label="Scoreboard">
      <h2 className="font-mono text-sm tracking-widest text-fg-dim">SCOREBOARD</h2>
      {!h2 || h2.rounds === 0 ? (
        <p className="font-mono text-xs text-fg-dim/70">no completed rounds yet</p>
      ) : (
        <div className="grid gap-x-8 gap-y-2 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3">
          <Stat
            label="heal rate"
            value={`${fmtPct(h2.heal_rate)} (${Math.round(h2.heal_rate * h2.rounds)}/${h2.rounds})`}
            bar={h2.heal_rate}
          />
          <Stat label="TTM p50" value={fmtMs(h2.median_ttm_ms)} />
          <Stat label="TTD p50" value={fmtMs(h2.median_ttd_ms)} />
          <Stat label="diag pass" value={fmtPct(h2.diag_pass_rate)} bar={h2.diag_pass_rate} />
          <Stat
            label="lucky fixes"
            value={fmtPct(h2.p_heal_given_no_diag)}
            bar={h2.p_heal_given_no_diag}
          />
          <Stat label="tool calls / round" value={h2.mean_tool_calls.toFixed(1)} />
        </div>
      )}
      {h2 && h2.by_fault.length > 0 && (
        <div>
          <button
            type="button"
            className="font-mono text-xs text-fg-dim hover:text-fg"
            onClick={() => setByFault((b) => !b)}
          >
            {byFault ? '▾' : '▸'} by fault
          </button>
          {byFault && (
            <table className="mt-2 w-full font-mono text-xs">
              <thead className="text-fg-dim">
                <tr>
                  <th className="py-1 text-left font-normal">fault</th>
                  <th className="py-1 text-right font-normal">rounds</th>
                  <th className="py-1 text-right font-normal">heal</th>
                  <th className="py-1 text-right font-normal">diag pass</th>
                  <th className="py-1 text-right font-normal">TTM p50</th>
                </tr>
              </thead>
              <tbody>
                {h2.by_fault.map((f) => (
                  <tr key={f.fault_id} className="border-t border-line/50">
                    <td className="py-1">{faultNames[f.fault_id] ?? f.fault_id}</td>
                    <td className="py-1 text-right">{f.rounds}</td>
                    <td className="py-1 text-right">{fmtPct(f.heal_rate)}</td>
                    <td className="py-1 text-right">{fmtPct(f.diag_pass_rate)}</td>
                    <td className="py-1 text-right">{fmtMs(f.median_ttm_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <WallOfFame entries={wall} faultNames={faultNames} />
    </section>
  );
}

function Stat({ label, value, bar }: { label: string; value: string; bar?: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/40 py-1">
      <span className="text-fg-dim">{label}</span>
      <span className="flex items-center gap-2 text-fg">
        {bar !== undefined && <Bar v={bar} />}
        {value}
      </span>
    </div>
  );
}
