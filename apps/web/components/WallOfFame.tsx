'use client';

import type { WallEntry } from '@/app/api/scoreboard/route';
import { fmtDate } from '@/lib/format';

export function WallOfFame({
  entries,
  faultNames,
}: {
  entries: WallEntry[];
  faultNames: Record<string, string>;
}) {
  return (
    <div>
      <h3 className="font-mono text-sm tracking-widest text-gold">WALL OF FAME</h3>
      <p className="mb-2 text-xs text-fg-dim">attackers whose faults the healer could not repair</p>
      {entries.length === 0 ? (
        <p className="font-mono text-xs text-fg-dim/70">nobody yet. the healer is undefeated.</p>
      ) : (
        <ul className="font-mono text-xs">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 border-t border-line/50 py-1">
              <span className="text-gold">{e.attacker_handle ?? 'anonymous'}</span>
              <span className="text-fg">
                {e.fault_ids.map((id) => faultNames[id] ?? id).join(' + ')}
              </span>
              <span className="text-fg-dim">{e.unhealed_reason ?? ''}</span>
              <span className="ml-auto text-fg-dim">{fmtDate(e.ended_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
