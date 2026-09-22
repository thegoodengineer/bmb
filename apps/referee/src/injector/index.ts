import { expandToSingles, type FaultId, getFault } from '@bmb/shared';
import { type Env, victimDir } from '../env.js';
import { D01, D02, D03, D04 } from './decoys.js';
import { F04 } from './functions.js';
import { F01, F02, F03, F05, F06, F07, F08, F09, F10 } from './singles.js';
import type { Injector, InjectorContext } from './types.js';

export type { Injector, InjectorContext } from './types.js';

const ALL: Injector[] = [F01, F02, F03, F04, F05, F06, F07, F08, F09, F10, D01, D02, D03, D04];

export const INJECTORS: ReadonlyMap<FaultId, Injector> = new Map(ALL.map((i) => [i.id, i]));

export const SINGLE_INJECTORS: readonly Injector[] = ALL.filter((i) => i.id.startsWith('F'));
export const DECOY_INJECTORS: readonly Injector[] = ALL.filter((i) => i.id.startsWith('D'));

export function injectorFor(id: FaultId): Injector {
  const inj = INJECTORS.get(id);
  if (!inj) throw new Error(`no injector for ${id}`);
  return inj;
}

/** Expand round fault ids (singles, decoys, combos) into the injectors to run, in order. */
export function injectorsForRound(faultIds: FaultId[]): Injector[] {
  const ids: FaultId[] = [];
  for (const id of faultIds) {
    const fault = getFault(id);
    if (!fault) throw new Error(`unknown fault ${id}`);
    for (const single of expandToSingles(id)) if (!ids.includes(single)) ids.push(single);
  }
  return ids.map(injectorFor);
}

/** Only the scored faults (not decoys) count toward the healed oracle. */
export function scoredInjectors(faultIds: FaultId[]): Injector[] {
  return injectorsForRound(faultIds).filter((i) => !i.id.startsWith('D'));
}

export function makeContext(env: Env, log: (command: string) => void = () => {}): InjectorContext {
  return { env, cwd: victimDir(env), log };
}

export async function artifactsPresent(
  ctx: InjectorContext,
  injectors: readonly Injector[],
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const inj of injectors) out[inj.id] = await inj.artifactPresent(ctx);
  return out;
}
