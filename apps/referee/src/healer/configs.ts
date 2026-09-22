import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HealerConfigId } from '@bmb/shared';
import { REFEREE_ROOT } from '../env.js';
import { ALL_TOOL_NAMES, type ToolName } from './tools.js';

/**
 * Healer configurations (SPEC.md §7.1).
 *
 *  H1 diagnose-only : diagnose_ai once + at most one db_query, then a fix. Max 4 tool calls.
 *  H2 agent+skill   : full tool set, system prompt = base + the insforge-debug skill text.
 *  H3 agent-noskill : full tool set, base prompt only.
 */
export interface HealerConfig {
  id: HealerConfigId;
  label: string;
  systemPrompt: string;
  maxToolCalls: number;
  maxWallClockMs: number;
  allowedTools: readonly ToolName[];
  maxCallsPerTool: Partial<Record<ToolName, number>>;
}

const PROMPTS_DIR = path.join(REFEREE_ROOT, 'prompts');

export function readPrompt(name: string): string {
  return readFileSync(path.join(PROMPTS_DIR, name), 'utf8');
}

/** SKILL.md followed by every reference file, in a stable order. */
export function readSkillText(includeReferences = true): string {
  const dir = path.join(PROMPTS_DIR, 'insforge-debug');
  const parts = [readFileSync(path.join(dir, 'SKILL.md'), 'utf8')];
  if (!includeReferences) return parts.join('');
  const refs = path.join(dir, 'references');
  for (const f of readdirSync(refs).sort()) {
    parts.push(`\n\n---\n# reference: ${f}\n\n${readFileSync(path.join(refs, f), 'utf8')}`);
  }
  return parts.join('');
}

/**
 * How much of the vendored skill H2 carries:
 *  full    SKILL.md + the nine reference files (~15k tokens; the benchmark definition)
 *  core    SKILL.md only (~4.3k tokens)
 *  compact the primitives table and the six app-level recipes (~2k tokens), for providers
 *          whose free tiers cap a request at 7–8k tokens per minute
 */
export type SkillSize = 'full' | 'core' | 'compact';

const COMPACT_SECTIONS = [
  /^## Fastest Path/,
  /^## Debug Primitives/,
  /^### Recipe: SDK returned/,
  /^### Recipe: HTTP 4xx\/5xx/,
  /^### Recipe: RLS access issue/,
  /^### Recipe: Edge function runtime error/,
  /^### Recipe: Single slow query/,
  /^### Recipe: Don't know where to start/,
];

/** The vendored SKILL.md cut to the sections useful for app-level faults. */
export function compactSkillText(): string {
  const skill = readSkillText(false).replace(/^---[\s\S]*?---\s*/, '');
  const sections = skill.split(/^(?=#{2,3} )/m);
  const kept = sections.filter((s) => COMPACT_SECTIONS.some((re) => re.test(s)));
  return `# InsForge Debug (compact)\n\n${kept.join('\n').trim()}\n`;
}

export function skillText(size: SkillSize): string {
  if (size === 'compact') return compactSkillText();
  return readSkillText(size === 'full');
}

export interface BuildOptions {
  /** How much of the skill H2 carries. Default full. */
  skill?: SkillSize;
  /** Wall clock per round; the benchmark default is 5 minutes. */
  wallClockMs?: number;
}

export function buildConfig(id: HealerConfigId, opts: BuildOptions = {}): HealerConfig {
  const base = readPrompt('base.md');
  const wall = opts.wallClockMs ?? 300_000;
  switch (id) {
    case 'H1':
      return {
        id,
        label: 'diagnose-only',
        systemPrompt: `${base}\n\n${readPrompt('h1-addendum.md')}`,
        maxToolCalls: 4,
        maxWallClockMs: wall,
        allowedTools: [
          'probe_status',
          'diagnose_ai',
          'db_query',
          'submit_diagnosis',
          'db_execute',
          'deploy_function',
        ],
        maxCallsPerTool: { diagnose_ai: 1, db_query: 1, probe_status: 1 },
      };
    case 'H2':
      return {
        id,
        label: 'agent+skill',
        systemPrompt: `${base}\n\n${readPrompt('with-skill-preamble.md')}\n\n${skillText(opts.skill ?? 'full')}`,
        maxToolCalls: 25,
        maxWallClockMs: wall,
        allowedTools: ALL_TOOL_NAMES,
        maxCallsPerTool: {},
      };
    case 'H3':
      return {
        id,
        label: 'agent-noskill',
        systemPrompt: base,
        maxToolCalls: 25,
        maxWallClockMs: wall,
        allowedTools: ALL_TOOL_NAMES,
        maxCallsPerTool: {},
      };
  }
}
