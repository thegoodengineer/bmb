import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type Fault, type FaultId, getFault } from '@bmb/shared';
import { z } from 'zod';
import type { Env } from './env.js';
import type { Diagnosis } from './healer/tools.js';

/**
 * Diagnosis judge (SPEC.md §8.2): nine yes/no questions over three dimensions, graded from
 * the ground truth and the healer's LAST diagnosis only. Never the tool history.
 *
 * Pass = score >= 7 AND no dimension scored 0. The verdict JSON is stored on the round.
 */
export const JUDGE_QUESTIONS = [
  'Localization 1: does the diagnosis name the same component(s) as the ground truth?',
  'Localization 2: does it distinguish the origin from downstream symptoms (blames the object, not the API status)?',
  'Localization 3: does it avoid naming a healthy component as the origin?',
  'Characterization 4: does it identify the same mechanism (what is wrong, not just "broken")?',
  'Characterization 5: does it include a concrete detail (policy, index, column, trigger, constraint or function name)?',
  'Characterization 6: does it avoid attributing the problem to an unrelated fault type?',
  'Scope 7: does it avoid blaming decoys or uninvolved components?',
  'Scope 8: for compound faults, does it name BOTH faults? (single fault: answer yes)',
  'Scope 9: is the described impact consistent with the probes actually affected?',
] as const;

export const judgeOutputSchema = z.object({
  answers: z.array(z.boolean()).length(9),
  evidence: z.array(z.string()).length(9),
});
export type JudgeAnswers = z.infer<typeof judgeOutputSchema>;

export interface JudgeVerdict extends JudgeAnswers {
  score: number;
  pass: boolean;
  dims: { loc: number; char: number; scope: number };
  model: string;
}

export const JUDGE_PASS_THRESHOLD = 7;

export function scoreAnswers(a: JudgeAnswers, model: string): JudgeVerdict {
  const dims = {
    loc: a.answers.slice(0, 3).filter(Boolean).length,
    char: a.answers.slice(3, 6).filter(Boolean).length,
    scope: a.answers.slice(6, 9).filter(Boolean).length,
  };
  const score = dims.loc + dims.char + dims.scope;
  const pass = score >= JUDGE_PASS_THRESHOLD && dims.loc > 0 && dims.char > 0 && dims.scope > 0;
  return { ...a, score, pass, dims, model };
}

export interface JudgeInput {
  faultIds: FaultId[];
  diagnosis: Diagnosis | undefined;
  /** Probe names that were actually red at attack time. */
  affectedProbes: string[];
}

export function buildJudgePrompt(input: JudgeInput): { system: string; user: string } {
  const faults = input.faultIds.map((id) => getFault(id)).filter((f): f is Fault => !!f);
  const scored = faults.filter((f) => f.tier !== 'decoy');
  const decoys = faults.filter((f) => f.tier === 'decoy');
  const isCombo = scored.some((f) => f.tier === 'combo') || scored.length > 1;

  const truth = scored
    .map(
      (f) =>
        `- component: ${f.groundTruth.component}\n  mechanism: ${f.groundTruth.mechanism}\n  affected probes: ${f.groundTruth.scope.join(', ')}`,
    )
    .join('\n');
  const decoyText = decoys.length
    ? decoys
        .map((d) => `- ${d.groundTruth.component}: ${d.groundTruth.mechanism} (harmless)`)
        .join('\n')
    : '- none';

  const system = `You grade an on-call engineer's written diagnosis of an injected backend fault against the ground truth.
Answer nine yes/no questions strictly. "Same component" means the same object (table, policy, index, trigger, constraint, function), not the same layer. Vague answers ("auth is broken", "the database") fail characterization. A diagnosis that names a decoy as the origin fails scope. For a single fault, question 8 is automatically yes. Give one short evidence sentence per answer, quoting the diagnosis where useful. Return only the JSON object.`;

  const user = `GROUND TRUTH (${isCombo ? 'compound: two faults' : 'single fault'}):
${truth}

DECOYS present (harmless noise the engineer should NOT blame):
${decoyText}

Probes actually red at attack time: ${input.affectedProbes.join(', ') || 'unknown'}

ENGINEER'S FINAL DIAGNOSIS:
${input.diagnosis ? JSON.stringify(input.diagnosis, null, 2) : '(no diagnosis was submitted)'}

QUESTIONS:
${JUDGE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

  return { system, user };
}

export interface JudgeModel {
  readonly model: string;
  grade(prompt: { system: string; user: string }): Promise<JudgeAnswers>;
}

export function anthropicJudge(model: string, apiKey?: string): JudgeModel {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  return {
    model,
    async grade(prompt) {
      const response = await client.messages.parse({
        model,
        max_tokens: 2000,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        output_config: { format: zodOutputFormat(judgeOutputSchema), effort: 'low' },
      });
      if (!response.parsed_output) throw new Error('judge returned no parsable output');
      return response.parsed_output;
    },
  };
}

export async function judgeRound(judge: JudgeModel, input: JudgeInput): Promise<JudgeVerdict> {
  if (!input.diagnosis) {
    return scoreAnswers(
      { answers: Array(9).fill(false), evidence: Array(9).fill('no diagnosis submitted') },
      judge.model,
    );
  }
  const answers = await judge.grade(buildJudgePrompt(input));
  return scoreAnswers(answers, judge.model);
}

/** A scripted judge for tests. */
export function scriptedJudge(answers: boolean[]): JudgeModel {
  return {
    model: 'scripted',
    async grade() {
      return { answers, evidence: answers.map((a) => (a ? 'yes' : 'no')) };
    },
  };
}

/** The judge for the configured provider (SPEC.md §2, plus the free-tier providers). */
export async function judgeFromEnv(env: Env): Promise<JudgeModel> {
  if (env.LLM_PROVIDER === 'anthropic') {
    return anthropicJudge(env.JUDGE_MODEL, env.ANTHROPIC_API_KEY);
  }
  const { openAICompatJudge } = await import('./judge-compat.js');
  return openAICompatJudge(env);
}
