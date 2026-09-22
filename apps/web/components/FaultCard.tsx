'use client';

import { useState } from 'react';
import type { PublicFault } from '@/lib/catalog';

interface Props {
  fault: PublicFault;
  decoys: PublicFault[];
  disabled: boolean;
  onAttack: (faultId: string, decoyId: string | undefined) => void;
}

export function FaultCard({ fault, decoys, disabled, onAttack }: Props) {
  const [decoy, setDecoy] = useState<string>('');
  const points = decoy ? fault.points * 1.5 : fault.points;

  return (
    <article className="flex flex-col gap-2 rounded-[6px] border border-line bg-bg-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-sm text-fg">{fault.name}</h3>
        <span className="font-mono text-xs text-gold-dim">{points}pt</span>
      </div>
      <p className="text-sm text-fg-dim">{fault.blurb}</p>
      {fault.composedOf && (
        <p className="font-mono text-[11px] text-fg-dim/70">two faults, overlapping symptoms</p>
      )}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <select
          value={decoy}
          onChange={(e) => setDecoy(e.target.value)}
          aria-label="decoy"
          className="min-w-0 flex-1 rounded-[6px] border border-line bg-bg px-2 py-1 font-mono text-xs text-fg-dim"
        >
          <option value="">+ decoy (none)</option>
          {decoys.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ×1.5
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAttack(fault.id, decoy || undefined)}
          className="rounded-[6px] border border-red/70 px-3 py-1 font-mono text-xs text-red hover:bg-red/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          ATTACK
        </button>
      </div>
    </article>
  );
}
