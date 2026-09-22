import { type FaultId, faultsOfTier, getFault, type ProbeId } from '@bmb/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';
import { sql } from '../src/injector/helpers.js';
import {
  DECOY_INJECTORS,
  type Injector,
  type InjectorContext,
  injectorFor,
  makeContext,
  SINGLE_INJECTORS,
} from '../src/injector/index.js';
import { allGreen, runProbeSuite } from '../src/probes.js';
import { resetVictim } from '../src/reset.js';

/**
 * Phase 2 gate (SPEC.md §11). Runs against the real cloud victim:
 *
 *  singles:  inject → some scope probe red within 30 s, and ONLY scope probes red
 *            → artifactPresent() === true → referenceFix → green ×3 → artifactPresent() === false
 *  decoys:   inject alone → green ×3 → cleanup → artifact gone
 *  combos:   inject both → both artifacts present → fixing only the first leaves probes red
 *            → fixing the second → green ×3
 *
 * Every case applies its reference fix in `finally`, so one failed assertion cannot leave
 * the victim broken for the next case. Skipped when the referee .env is absent.
 */

let env: ReturnType<typeof loadEnv> | undefined;
try {
  env = loadEnv();
} catch {
  env = undefined;
}

const RED_DEADLINE_MS = 30_000;
const GREEN_STREAK = 3;
const GREEN_DEADLINE_MS = 120_000;
const CYCLE_GAP_MS = 1500;

const log = (cmd: string) => console.log(`    $ ${cmd.slice(0, 140)}`);

function redSummary(results: Awaited<ReturnType<typeof runProbeSuite>>): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `${r.name}:${r.error}`)
    .join(' | ');
}

async function waitForRed(e: NonNullable<typeof env>): Promise<Set<ProbeId>> {
  const deadline = Date.now() + RED_DEADLINE_MS;
  let lastRed = new Set<ProbeId>();
  while (Date.now() < deadline) {
    const results = await runProbeSuite(e);
    lastRed = new Set(results.filter((r) => !r.ok).map((r) => r.name));
    if (lastRed.size > 0) {
      console.log(`    red: ${[...lastRed].join(',')}  ${redSummary(results)}`);
      return lastRed;
    }
    await sleep(CYCLE_GAP_MS);
  }
  return lastRed;
}

async function waitForGreenStreak(e: NonNullable<typeof env>): Promise<boolean> {
  const deadline = Date.now() + GREEN_DEADLINE_MS;
  let streak = 0;
  while (Date.now() < deadline) {
    const results = await runProbeSuite(e);
    if (allGreen(results)) {
      streak++;
      if (streak >= GREEN_STREAK) return true;
    } else {
      streak = 0;
      console.log(`    still red: ${redSummary(results)}`);
    }
    await sleep(CYCLE_GAP_MS);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run the reference fix no matter what; report but do not mask the original failure. */
async function withFix<T>(
  ctx: InjectorContext,
  injectors: Injector[],
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body();
  } finally {
    for (const inj of injectors) {
      try {
        await inj.referenceFix(ctx);
      } catch (e) {
        console.log(`    cleanup ${inj.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

describe.skipIf(!env)('fault injectors against the victim', () => {
  const e = env as NonNullable<typeof env>;
  let ctx: InjectorContext;

  beforeAll(async () => {
    ctx = makeContext(e, log);
    const report = await resetVictim(e, log);
    console.log(`  reset before suite: ${report.ms} ms`);
    expect(await waitForGreenStreak(e), 'victim must be green before the suite').toBe(true);
  });

  afterAll(async () => {
    const report = await resetVictim(e, log);
    console.log(`  reset after suite: ${report.ms} ms`);
  });

  describe('singles: inject → red (scope only) → artifact → fix → green ×3 → no artifact', () => {
    for (const inj of SINGLE_INJECTORS) {
      const fault = getFault(inj.id);
      if (!fault) throw new Error(`catalog missing ${inj.id}`);
      it(`${inj.id} ${fault.name}`, async () => {
        await withFix(ctx, [inj], async () => {
          await inj.inject(ctx);
          const red = await waitForRed(e);
          expect(
            red.size,
            `${inj.id}: no probe went red within ${RED_DEADLINE_MS} ms`,
          ).toBeGreaterThan(0);
          for (const p of red) {
            expect(
              fault.groundTruth.scope,
              `${inj.id}: ${p} went red but is not in scope`,
            ).toContain(p);
          }
          expect(await inj.artifactPresent(ctx), `${inj.id}: artifact not detected`).toBe(true);

          await inj.referenceFix(ctx);
          expect(
            await inj.artifactPresent(ctx),
            `${inj.id}: artifact still present after fix`,
          ).toBe(false);
          expect(await waitForGreenStreak(e), `${inj.id}: not green ×3 after fix`).toBe(true);
        });
      });
    }
  });

  describe('decoys alone: probes stay green', () => {
    for (const inj of DECOY_INJECTORS) {
      it(`${inj.id} ${getFault(inj.id)?.name}`, async () => {
        await withFix(ctx, [inj], async () => {
          await inj.inject(ctx);
          expect(await inj.artifactPresent(ctx), `${inj.id}: artifact not detected`).toBe(true);
          expect(await waitForGreenStreak(e), `${inj.id}: a decoy turned a probe red`).toBe(true);
          await inj.referenceFix(ctx);
          expect(await inj.artifactPresent(ctx), `${inj.id}: artifact still present`).toBe(false);
        });
      });
    }
  });

  describe('combos: both artifacts; fixing one is not enough', () => {
    for (const combo of faultsOfTier('combo')) {
      it(`${combo.id} ${combo.name} = ${combo.composedOf?.join(' + ')}`, async () => {
        const [a, b] = (combo.composedOf ?? []) as [FaultId, FaultId];
        const ia = injectorFor(a);
        const ib = injectorFor(b);
        await withFix(ctx, [ia, ib], async () => {
          await ia.inject(ctx);
          await ib.inject(ctx);
          expect(await ia.artifactPresent(ctx), `${a} artifact`).toBe(true);
          expect(await ib.artifactPresent(ctx), `${b} artifact`).toBe(true);
          const red = await waitForRed(e);
          expect(red.size).toBeGreaterThan(0);
          for (const p of red) {
            expect(combo.groundTruth.scope, `${combo.id}: ${p} out of scope`).toContain(p);
          }

          await ia.referenceFix(ctx);
          const stillRed = await waitForRed(e);
          expect(
            stillRed.size,
            `${combo.id}: fixing ${a} alone made everything green`,
          ).toBeGreaterThan(0);
          expect(await ib.artifactPresent(ctx), `${b} artifact after fixing ${a}`).toBe(true);

          await ib.referenceFix(ctx);
          expect(await waitForGreenStreak(e)).toBe(true);
          expect(await ia.artifactPresent(ctx)).toBe(false);
          expect(await ib.artifactPresent(ctx)).toBe(false);
        });
      });
    }
  });

  // Repairs healers actually made in public rounds (docs/MISSES.md). The oracle judges state,
  // so a correct repair under a healer's own naming must count, and a workaround must not.
  describe('healer repairs from public rounds', () => {
    it('F08: re-adding the constraint name with a sane rule is a repair', async () => {
      const inj = injectorFor('F08');
      await withFix(ctx, [inj], async () => {
        await inj.inject(ctx);
        expect(await inj.artifactPresent(ctx)).toBe(true);
        expect((await waitForRed(e)).size).toBeGreaterThan(0);
        await sql(ctx, 'alter table notes drop constraint notes_title_impossible');
        await sql(
          ctx,
          'alter table notes add constraint notes_title_impossible check (length(title) > 0)',
        );
        expect(await waitForGreenStreak(e)).toBe(true);
        expect(await inj.artifactPresent(ctx), 'sane replacement read as the fault').toBe(false);
      });
      // The reset removes the replacement too: the baseline has no CHECK constraints.
      const left = await sql(
        ctx,
        `select 1 from pg_constraint k join pg_class c on c.oid = k.conrelid
          where c.relname = 'notes' and k.contype = 'c'`,
      );
      expect(left).toHaveLength(0);
    });

    it('F05: a generated body column beside content is a workaround, and the reset survives it', async () => {
      const inj = injectorFor('F05');
      await withFix(ctx, [inj], async () => {
        await inj.inject(ctx);
        await sql(
          ctx,
          'alter table notes add column body text generated always as (content) stored',
        );
        expect(await inj.artifactPresent(ctx), 'workaround read as a repair').toBe(true);
      });
      expect(await inj.artifactPresent(ctx)).toBe(false);
      expect(await waitForGreenStreak(e)).toBe(true);
    });
  });
});
