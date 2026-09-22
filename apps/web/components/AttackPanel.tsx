'use client';

import { useEffect, useState } from 'react';
import type { PublicFault } from '@/lib/catalog';
import { FaultCard } from './FaultCard';

interface Props {
  catalog: PublicFault[];
  /** Position in queue for the viewer's queued round, if any (0 = up next). */
  queueAhead: number | null;
  onAttacked: (roundId: string) => void;
}

type Tab = 'single' | 'combo';

export function AttackPanel({ catalog, queueAhead, onAttacked }: Props) {
  const [tab, setTab] = useState<Tab>('single');
  const [handle, setHandle] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmb_handle');
      if (saved) setHandle(saved);
    } catch {}
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => {
    if (queueAhead === null) setQueued(false);
  }, [queueAhead]);

  const decoys = catalog.filter((f) => f.tier === 'decoy');
  const cards = catalog.filter((f) => f.tier === tab);
  const disabled = busy || cooldown > 0 || queued;

  async function attack(faultId: string, decoyId: string | undefined) {
    setBusy(true);
    setError(null);
    try {
      try {
        localStorage.setItem('bmb_handle', handle);
      } catch {}
      const res = await fetch('/api/attack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faultId, decoyId, handle: handle.trim() || undefined }),
      });
      const body = (await res.json()) as {
        roundId?: string;
        position?: number;
        error?: string;
        retryAfterSeconds?: number;
      };
      if (!res.ok) {
        if (body.retryAfterSeconds) setCooldown(body.retryAfterSeconds);
        setError(body.error ?? `error ${res.status}`);
        return;
      }
      if (body.roundId) {
        setQueued(true);
        setCooldown(180);
        onAttacked(body.roundId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Attack">
      <header className="flex items-center justify-between">
        <h2 className="font-mono text-sm tracking-widest text-fg-dim">ATTACK</h2>
        <div className="flex gap-1 font-mono text-xs">
          {(['single', 'combo'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-[6px] border px-2 py-1 ${tab === t ? 'border-gold text-gold' : 'border-line text-fg-dim hover:text-fg'}`}
            >
              {t === 'single' ? 'Singles' : 'Combos'}
            </button>
          ))}
        </div>
      </header>

      <label className="flex items-center gap-2 font-mono text-xs text-fg-dim">
        handle
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16))}
          placeholder="optional, 3–16 chars"
          className="flex-1 rounded-[6px] border border-line bg-bg-2 px-2 py-1 text-fg outline-none focus:border-gold-dim"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        {cards.map((f) => (
          <FaultCard key={f.id} fault={f} decoys={decoys} disabled={disabled} onAttack={attack} />
        ))}
      </div>

      <div className="min-h-5 font-mono text-xs text-fg-dim">
        {error && <span className="text-red">{error}</span>}
        {!error && cooldown > 0 && (
          <span>
            cooldown: {Math.floor(cooldown / 60)}:{String(cooldown % 60).padStart(2, '0')}
          </span>
        )}
        {queueAhead !== null && <span className="ml-3">queue: {queueAhead} ahead</span>}
      </div>
    </section>
  );
}
