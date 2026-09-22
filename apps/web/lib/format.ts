export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  return `${Math.round(v * 100)}%`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(11, 19);
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '–';
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ');
}

/** Status pill states derived from the latest round (SPEC.md §9.3). */
export type PillState = 'HEALTHY' | 'UNDER ATTACK' | 'HEALING' | 'HEALED' | 'UNHEALED';

export function pillState(
  status: string | undefined,
  healed: boolean | null | undefined,
): PillState {
  switch (status) {
    case 'injecting':
    case 'attacked':
      return 'UNDER ATTACK';
    case 'healing':
      return 'HEALING';
    case 'healed':
      return 'HEALED';
    case 'unhealed':
      return 'UNHEALED';
    case 'resetting':
      return healed === false ? 'UNHEALED' : 'HEALED';
    default:
      return 'HEALTHY';
  }
}
