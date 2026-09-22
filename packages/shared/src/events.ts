import { z } from 'zod';

/**
 * Zod schemas for everything that crosses a trust boundary: round rows, event payloads,
 * healer tool inputs. Phase 0 defines the round lifecycle and event kinds; payload
 * schemas are filled in as each phase lands.
 */

export const ROUND_STATUSES = [
  'queued',
  'injecting',
  'attacked',
  'healing',
  'healed',
  'unhealed',
  'invalid',
  'resetting',
  'done',
] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];
export const roundStatusSchema = z.enum(ROUND_STATUSES);

export const HEALER_CONFIGS = ['H1', 'H2', 'H3'] as const;
export type HealerConfigId = (typeof HEALER_CONFIGS)[number];
export const healerConfigSchema = z.enum(HEALER_CONFIGS);

export const EVENT_KINDS = [
  'attack',
  'probe',
  'healer_thought',
  'tool_call',
  'tool_result',
  'diagnosis',
  'fix_applied',
  'verify',
  'healed',
  'gave_up',
  'reset',
  'judge',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const eventKindSchema = z.enum(EVENT_KINDS);

export const probeResultSchema = z.object({
  name: z.enum(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']),
  ok: z.boolean(),
  ms: z.number().nonnegative(),
  error: z.string().optional(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;
