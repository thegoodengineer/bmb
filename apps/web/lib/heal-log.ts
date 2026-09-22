import type { PublicEvent } from './control';

/**
 * Probe cycles run every 3 seconds during a round. The heal log shows a probe line only
 * when the set of red probes changes; repeats fold into a count on that line.
 */
export interface HealLogRow {
  e: PublicEvent;
  repeats: number;
}

function probeKey(e: PublicEvent): string | undefined {
  if (e.kind !== 'probe') return undefined;
  const results = (e.payload.results as { name: string; ok: boolean }[] | undefined) ?? [];
  return results
    .filter((r) => !r.ok)
    .map((r) => r.name)
    .join(',');
}

export function collapseProbes(events: PublicEvent[]): HealLogRow[] {
  const rows: HealLogRow[] = [];
  let lastProbe: HealLogRow | undefined;
  for (const e of events) {
    const key = probeKey(e);
    if (key === undefined) {
      rows.push({ e, repeats: 1 });
      continue;
    }
    if (lastProbe && probeKey(lastProbe.e) === key) {
      lastProbe.repeats++;
      continue;
    }
    lastProbe = { e, repeats: 1 };
    rows.push(lastProbe);
  }
  return rows;
}
