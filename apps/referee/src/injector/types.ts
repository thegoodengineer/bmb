import type { FaultId } from '@bmb/shared';
import type { Env } from '../env.js';

/**
 * One injector per single fault and per decoy. Combos are compositions (see index.ts).
 *
 * Every method runs real CLI commands against the victim and logs each one through
 * `ctx.log`, so the referee's event stream shows exactly what was done.
 *
 * `artifactPresent` MUST be a state check (pg_policies, pg_indexes, pg_trigger, pg_proc,
 * information_schema, `functions code`), never a probe. It is the reward-hacking guard:
 * probes can be made green by working around a fault; the artifact check cannot.
 */
export interface InjectorContext {
  env: Env;
  /** The linked victim directory every CLI call runs in. */
  cwd: string;
  /** Called with the human-readable command for every CLI invocation. */
  log: (command: string) => void;
}

export interface Injector {
  id: FaultId;
  inject(ctx: InjectorContext): Promise<void>;
  referenceFix(ctx: InjectorContext): Promise<void>;
  artifactPresent(ctx: InjectorContext): Promise<boolean>;
}
