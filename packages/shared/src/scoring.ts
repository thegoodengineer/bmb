/**
 * Pure scoring functions. No I/O, no randomness, fully unit-tested in Phase 4.
 *
 * Attacker points = fault.points × (decoy ? 1.5 : 1) × (healed ? 0 : 1)
 *                 + (healed && !judgePass ? 0.5 × points : 0)
 * i.e. the attacker scores fully if unhealed, half if healed by a lucky fix.
 */
export interface AttackerPointsInput {
  points: number;
  hasDecoy: boolean;
  healed: boolean;
  judgePass: boolean;
}

export function attackerPoints(input: AttackerPointsInput): number {
  const base = input.points * (input.hasDecoy ? 1.5 : 1);
  if (!input.healed) return base;
  return input.judgePass ? 0 : 0.5 * base;
}
