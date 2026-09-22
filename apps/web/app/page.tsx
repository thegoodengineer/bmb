import { PROBE_IDS } from '@bmb/shared';

export default function Page() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="font-mono text-2xl tracking-tight">BREAK MY BACKEND</h1>
      <p className="mt-2 text-fg-dim">Strangers break a real backend. An AI fixes it. Live.</p>
      <p className="mt-8 font-mono text-sm text-fg-dim">
        phase 0 skeleton · probes: {PROBE_IDS.join(' ')}
      </p>
    </main>
  );
}
