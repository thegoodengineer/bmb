import type { Env } from './env.js';
import { chatCompletion } from './healer/openai-compat.js';
import { compatOptions } from './healer/provider.js';
import { type JudgeAnswers, type JudgeModel, judgeOutputSchema } from './judge.js';

/**
 * Judge over an OpenAI-compatible endpoint: JSON mode plus zod validation, one retry with
 * the validation error fed back. Used when LLM_PROVIDER is not anthropic.
 */
export function openAICompatJudge(env: Env): JudgeModel {
  const opts = compatOptions(env, env.JUDGE_MODEL, 'judge');
  return {
    model: opts.model,
    async grade(prompt) {
      const schemaNote =
        'Return ONLY a JSON object of the form {"answers":[9 booleans],"evidence":[9 short strings]} with exactly nine entries each, in question order.';
      let feedback = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await chatCompletion(opts, {
          messages: [
            { role: 'system', content: `${prompt.system}\n\n${schemaNote}` },
            { role: 'user', content: `${prompt.user}${feedback}` },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 1500,
        });
        const text = res.choices?.[0]?.message?.content ?? '';
        const parsed = tryParse(text);
        const valid = judgeOutputSchema.safeParse(parsed);
        if (valid.success) return valid.data as JudgeAnswers;
        feedback = `\n\nYour previous reply was not valid: ${valid.error.issues.map((i) => i.message).join('; ')}. ${schemaNote}`;
      }
      throw new Error('judge returned no valid JSON after two attempts');
    },
  };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      return JSON.parse(m[0]);
    } catch {
      return undefined;
    }
  }
}
