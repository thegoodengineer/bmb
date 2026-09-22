import type { Env } from './env.js';
import {
  artifactsPresent,
  DECOY_INJECTORS,
  type InjectorContext,
  makeContext,
  SINGLE_INJECTORS,
} from './injector/index.js';
import { seedVictim } from './victim/seed.js';

/**
 * Between-round reset (SPEC.md §7.2, docs/INSFORGE_NOTES.md §F for why not branch reset):
 *  1. apply every single fault's reference fix (idempotent), in an order that respects
 *     dependencies (F05 rename-back before anything that touches the body column)
 *  2. clean up every decoy
 *  3. re-run the idempotent seed (users, probe notes, filler top-up, stray-note cleanup)
 *  4. verify no artifact is present
 */
export interface ResetReport {
  fixed: string[];
  cleaned: string[];
  /** Fixes that threw on the first pass (retried once after everything else). */
  retried: string[];
  artifactsAfter: Record<string, boolean>;
  ms: number;
}

/**
 * Apply every fix even if one throws: a healer can leave the victim in states no reference
 * fix anticipated, and one failing statement must not leave the other faults in place. Fixes
 * that failed are retried once after the rest (their preconditions may now hold). Only
 * leftover artifacts make the reset fail.
 */
export async function resetVictim(
  env: Env,
  log: (command: string) => void = () => {},
): Promise<ResetReport> {
  const started = Date.now();
  const ctx: InjectorContext = makeContext(env, log);
  const ordered = [...[...SINGLE_INJECTORS].sort(byResetOrder), ...DECOY_INJECTORS];

  const failed: typeof ordered = [];
  for (const inj of ordered) {
    try {
      await inj.referenceFix(ctx);
    } catch (e) {
      log(`reset: ${inj.id} fix failed, will retry: ${e instanceof Error ? e.message : e}`);
      failed.push(inj);
    }
  }
  for (const inj of failed) {
    try {
      await inj.referenceFix(ctx);
    } catch (e) {
      log(`reset: ${inj.id} fix failed again: ${e instanceof Error ? e.message : e}`);
    }
  }
  const fixed = SINGLE_INJECTORS.map((i) => i.id);
  const cleaned = DECOY_INJECTORS.map((i) => i.id);
  const retried = failed.map((i) => i.id);

  await seedVictim(env);

  const artifactsAfter = await artifactsPresent(ctx, [...SINGLE_INJECTORS, ...DECOY_INJECTORS]);
  const leftover = Object.entries(artifactsAfter).filter(([, present]) => present);
  if (leftover.length > 0) {
    throw new Error(`reset left artifacts behind: ${leftover.map(([id]) => id).join(', ')}`);
  }
  return { fixed, cleaned, retried, artifactsAfter, ms: Date.now() - started };
}

/** F05 first (column name), everything else in catalog order. */
function byResetOrder(a: { id: string }, b: { id: string }): number {
  const rank = (id: string) => (id === 'F05' ? 0 : 1);
  return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id);
}
