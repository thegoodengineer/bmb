import type { ProbeResult } from '@bmb/shared';
import type { Env } from './env.js';
import type { EventSink } from './events.js';
import { allGreen, runProbeSuite } from './probes.js';

/**
 * Runs the probe suite on a timer and keeps the latest results plus the current streak of
 * consecutive all-green cycles. This is the referee's live view of the victim; the oracle
 * reads `greenStreak`, the healer's `probe_status` tool reads `latest`.
 *
 * Interval is 3 s while a round is active and 15 s when idle (SPEC.md §5.6). Cycles never
 * overlap: a new cycle starts only after the previous one finished plus the gap.
 */
export class ProbeMonitor {
  private latestResults: ProbeResult[] = [];
  private streak = 0;
  private cycles = 0;
  private running = false;
  private active = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<ProbeResult[]> | undefined;
  private waiters: Array<(r: ProbeResult[]) => void> = [];

  constructor(
    private readonly env: Env,
    private readonly sink?: EventSink,
    private readonly gaps = { active: 3000, idle: 15_000 },
  ) {}

  get latest(): ProbeResult[] {
    return this.latestResults;
  }
  get greenStreak(): number {
    return this.streak;
  }
  get cycleCount(): number {
    return this.cycles;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  start(active = false): void {
    if (this.running) return;
    this.running = true;
    this.active = active;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Force a cycle now (or join the one in flight) and return its results. */
  async runNow(): Promise<ProbeResult[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.cycle();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** Resolves with the results of the NEXT completed cycle. */
  nextCycle(): Promise<ProbeResult[]> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Reset the streak (call right after injecting so stale green cycles do not count). */
  resetStreak(): void {
    this.streak = 0;
  }

  private async cycle(): Promise<ProbeResult[]> {
    const results = await runProbeSuite(this.env);
    this.latestResults = results;
    this.cycles++;
    this.streak = allGreen(results) ? this.streak + 1 : 0;
    await this.sink?.record('probe', {
      results,
      green: allGreen(results),
      streak: this.streak,
    });
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w(results);
    return results;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runNow();
      } catch {
        // runProbeSuite never throws; belt and braces
      }
      const gap = this.active ? this.gaps.active : this.gaps.idle;
      await new Promise<void>((r) => {
        this.timer = setTimeout(r, gap);
      });
    }
  }
}
