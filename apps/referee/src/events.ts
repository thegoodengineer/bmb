import type { EventKind } from '@bmb/shared';

/**
 * Where round events go. The referee records every probe cycle, healer thought, tool call,
 * tool result, diagnosis, verdict and reset as an event. Phase 5 adds a sink that writes to
 * the control project; tests and the `heal` CLI use the in-memory sink.
 */
export interface RoundEvent {
  at: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export interface EventSink {
  record(kind: EventKind, payload: Record<string, unknown>): Promise<void> | void;
}

export class MemorySink implements EventSink {
  readonly events: RoundEvent[] = [];
  constructor(private readonly echo?: (e: RoundEvent) => void) {}
  record(kind: EventKind, payload: Record<string, unknown>): void {
    const e = { at: new Date().toISOString(), kind, payload };
    this.events.push(e);
    this.echo?.(e);
  }
}

/** Fan out to several sinks (e.g. memory for the transcript + control DB for the web). */
export class MultiSink implements EventSink {
  constructor(private readonly sinks: EventSink[]) {}
  async record(kind: EventKind, payload: Record<string, unknown>): Promise<void> {
    for (const s of this.sinks) await s.record(kind, payload);
  }
}
