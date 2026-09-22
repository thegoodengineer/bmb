'use client';

import type { PillState } from '@/lib/format';

const STYLES: Record<PillState, string> = {
  HEALTHY: 'border-green/60 text-green',
  'UNDER ATTACK': 'border-red/70 text-red animate-pulse',
  HEALING: 'border-gold/70 text-gold',
  HEALED: 'border-green/60 text-green',
  UNHEALED: 'border-red/70 text-red',
};

export function StatusPill({ state }: { state: PillState }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-[6px] border px-2.5 py-1 font-mono text-xs tracking-wider ${STYLES[state]}`}
      aria-live="polite"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {state}
    </span>
  );
}
