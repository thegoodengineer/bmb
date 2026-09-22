'use client';

import { useState } from 'react';

const QUESTIONS = [
  ['Localization', 'Does it name the same component as the ground truth?'],
  ['Localization', 'Does it blame the origin rather than a downstream symptom?'],
  ['Localization', 'Does it avoid naming a healthy component?'],
  ['Characterization', 'Does it identify the same mechanism?'],
  [
    'Characterization',
    'Does it include a concrete detail (policy, index, column, trigger, constraint, function name)?',
  ],
  ['Characterization', 'Does it avoid attributing the problem to an unrelated fault type?'],
  ['Scope', 'Does it avoid blaming decoys or uninvolved components?'],
  ['Scope', 'For combos, does it name both faults?'],
  ['Scope', 'Is the described impact consistent with the probes actually affected?'],
];

export function HowScoringWorks() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="font-mono text-xs text-fg-dim hover:text-fg"
        onClick={() => setOpen(true)}
      >
        how scoring works ▸
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-[6px] border border-line bg-bg-2 p-5 text-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-mono tracking-widest text-fg">HOW SCORING WORKS</h2>
              <button
                type="button"
                className="font-mono text-fg-dim hover:text-fg"
                onClick={() => setOpen(false)}
              >
                close
              </button>
            </div>
            <p className="mt-3 text-fg-dim">
              A round is <span className="text-green">healed</span> only when the six synthetic-user
              probes pass three cycles in a row <em>and</em> the injected artifact is gone from the
              database or function state. Green probes with the artifact still present (a
              workaround) do not count.
            </p>
            <p className="mt-3 text-fg-dim">
              The healer must submit a diagnosis before it may change anything. A judge grades that
              diagnosis against the ground truth with nine yes/no questions in three dimensions.
              Pass = 7 of 9, and no dimension may score zero.
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-fg-dim">
              {QUESTIONS.map(([dim, q], i) => (
                <li key={q}>
                  <span className="font-mono text-xs text-gold-dim">{dim}</span> {q}
                  {i === 7 && <span className="text-fg-dim/70"> (singles: automatically yes)</span>}
                </li>
              ))}
            </ol>
            <h3 className="mt-4 font-mono text-xs tracking-widest text-fg-dim">ATTACKER POINTS</h3>
            <pre className="mt-1 rounded-[6px] bg-bg p-3 font-mono text-xs text-fg-dim">{`points × (decoy ? 1.5 : 1)   if the round is NOT healed
0.5 × that                     if healed but the diagnosis failed (a lucky fix)
0                              if healed with a passing diagnosis`}</pre>
            <p className="mt-3 text-fg-dim">
              Time to diagnose (TTD) runs from the first red probe to the first submitted diagnosis.
              Time to mitigate (TTM) runs from the first red probe to the moment the oracle first
              says healed. The lucky-fix rate is the share of rounds that were healed although the
              diagnosis failed.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
