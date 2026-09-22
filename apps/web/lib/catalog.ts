import 'server-only';
import { FAULTS, type FaultTier } from '@bmb/shared';

/**
 * The player-facing catalog. Built on the server and passed to client components as props,
 * so `groundTruth` never enters a browser bundle (tests/catalog.test.ts checks the shape).
 */
export interface PublicFault {
  id: string;
  tier: FaultTier;
  name: string;
  blurb: string;
  points: number;
  composedOf?: string[];
}

export function publicCatalog(): PublicFault[] {
  return FAULTS.map((f) => ({
    id: f.id,
    tier: f.tier,
    name: f.name,
    blurb: f.blurb,
    points: f.points,
    ...(f.composedOf ? { composedOf: [...f.composedOf] } : {}),
  }));
}

export function isValidAttack(faultId: string, decoyId: string | undefined): boolean {
  const fault = FAULTS.find((f) => f.id === faultId);
  if (!fault || fault.tier === 'decoy') return false;
  if (decoyId === undefined) return true;
  const decoy = FAULTS.find((f) => f.id === decoyId);
  return !!decoy && decoy.tier === 'decoy';
}
