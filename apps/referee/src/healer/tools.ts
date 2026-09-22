import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ProbeResult } from '@bmb/shared';
import { z } from 'zod';
import type { EventSink } from '../events.js';
import { runInsforge } from '../insforge-cli.js';

/**
 * The constrained tool set (SPEC.md §7.3).
 *
 * Every tool maps to ONE specific CLI command run in the victim's linked directory. There is
 * no shell, no filesystem, no free-form command. The only free-form input is SQL, and it is
 * filtered: read-mode SQL for `db_query`, an allow-list plus deny-list for `db_execute`.
 *
 * Write tools are locked until `submit_diagnosis` has been called at least once. The gate is
 * enforced here, not in the prompt.
 *
 * Nothing in this file imports the fault catalog. Tool results come from the victim and are
 * additionally scrubbed of anything shaped like a catalog id before the model sees them
 * (test/isolation.test.ts proves both).
 */

export const MAX_RESULT_CHARS = 6000;

export const LOG_SOURCES = [
  'insforge.logs',
  'postgREST.logs',
  'postgres.logs',
  'function.logs',
  'function-deploy.logs',
] as const;

export const DIAGNOSE_KINDS = ['advisor', 'db', 'metrics', 'logs'] as const;

export const DEPLOYABLE_SLUGS = ['summarize', 'legacy-ping'] as const;

export const READ_TOOLS = [
  'probe_status',
  'get_metadata',
  'diagnose',
  'diagnose_ai',
  'get_logs',
  'db_policies',
  'db_indexes',
  'db_triggers',
  'db_functions',
  'db_tables',
  'list_functions',
  'get_function_source',
  'db_query',
] as const;
export const GATE_TOOL = 'submit_diagnosis' as const;
export const WRITE_TOOLS = ['db_execute', 'deploy_function', 'run_migration_sql'] as const;

export type ToolName =
  | (typeof READ_TOOLS)[number]
  | typeof GATE_TOOL
  | (typeof WRITE_TOOLS)[number];

export const ALL_TOOL_NAMES: readonly ToolName[] = [...READ_TOOLS, GATE_TOOL, ...WRITE_TOOLS];

/* ------------------------------------------------------------------ input schemas */

const inputs = {
  probe_status: z.object({}).strict(),
  get_metadata: z.object({}).strict(),
  diagnose: z.object({ kind: z.enum(DIAGNOSE_KINDS) }).strict(),
  diagnose_ai: z.object({ question: z.string().min(3).max(2000) }).strict(),
  get_logs: z
    .object({
      source: z.enum(LOG_SOURCES),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  db_policies: z.object({}).strict(),
  db_indexes: z.object({}).strict(),
  db_triggers: z.object({}).strict(),
  db_functions: z.object({}).strict(),
  db_tables: z.object({}).strict(),
  list_functions: z.object({}).strict(),
  get_function_source: z.object({ slug: z.string().min(1).max(64) }).strict(),
  db_query: z.object({ sql: z.string().min(1).max(4000) }).strict(),
  submit_diagnosis: z
    .object({
      component: z.string().min(1).max(300),
      mechanism: z.string().min(1).max(600),
      affected: z.array(z.string().min(1).max(40)).max(12),
      confidence: z.number().min(0).max(1),
      reasoning: z.string().min(1).max(2000),
    })
    .strict(),
  db_execute: z.object({ sql: z.string().min(1).max(6000) }).strict(),
  run_migration_sql: z.object({ sql: z.string().min(1).max(6000) }).strict(),
  deploy_function: z
    .object({ slug: z.enum(DEPLOYABLE_SLUGS), source: z.string().min(1).max(20_000) })
    .strict(),
} as const;

export type Diagnosis = z.infer<typeof inputs.submit_diagnosis>;

/* ------------------------------------------------------------------ tool definitions */

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Anthropic.Tool.InputSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'probe_status',
    description:
      'Latest results of the synthetic-user probe suite (the alert). Each entry: {name, ok, ms, error?}. Call this first, and after every fix.',
    input_schema: obj({}),
  },
  {
    name: 'get_metadata',
    description: 'Backend metadata: auth config, tables, storage, edge functions, realtime.',
    input_schema: obj({}),
  },
  {
    name: 'diagnose',
    description:
      'Backend diagnostics. kind=advisor (static security/performance scan), db (connections, slow queries, bloat, index usage, locks), metrics (instance CPU/memory), logs (error-level logs across all sources).',
    input_schema: obj({ kind: { type: 'string', enum: [...DIAGNOSE_KINDS] } }, ['kind']),
  },
  {
    name: 'diagnose_ai',
    description:
      'Ask the platform debug agent about a concrete symptom. Returns SUGGESTIONS, not facts: verify against a primitive before acting.',
    input_schema: obj({ question: { type: 'string' } }, ['question']),
  },
  {
    name: 'get_logs',
    description: 'Recent backend logs from one source (newest last; output is tail-truncated).',
    input_schema: obj(
      {
        source: { type: 'string', enum: [...LOG_SOURCES] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      ['source'],
    ),
  },
  { name: 'db_policies', description: 'All RLS policies (pg_policies).', input_schema: obj({}) },
  { name: 'db_indexes', description: 'All indexes with definitions.', input_schema: obj({}) },
  { name: 'db_triggers', description: 'All triggers.', input_schema: obj({}) },
  {
    name: 'db_functions',
    description: 'All database functions with their full definitions.',
    input_schema: obj({}),
  },
  { name: 'db_tables', description: 'Table names in the public schema.', input_schema: obj({}) },
  { name: 'list_functions', description: 'Deployed edge functions.', input_schema: obj({}) },
  {
    name: 'get_function_source',
    description: 'Source code of a deployed edge function.',
    input_schema: obj({ slug: { type: 'string' } }, ['slug']),
  },
  {
    name: 'db_query',
    description:
      'Read-only SQL as the project admin (bypasses RLS). Must start with SELECT, EXPLAIN or WITH; one statement; no writes. Use it to inspect pg_catalog, information_schema, grants, and data.',
    input_schema: obj({ sql: { type: 'string' } }, ['sql']),
  },
  {
    name: 'submit_diagnosis',
    description:
      'Record your diagnosis. REQUIRED before any write tool unlocks. May be called again to revise. affected = probe names you believe are impacted.',
    input_schema: obj(
      {
        component: { type: 'string', description: 'The failing component, named concretely' },
        mechanism: { type: 'string', description: 'What exactly is wrong with it' },
        affected: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasoning: { type: 'string' },
      },
      ['component', 'mechanism', 'affected', 'confidence', 'reasoning'],
    ),
  },
  {
    name: 'db_execute',
    description:
      'One DDL statement in the public schema: CREATE, ALTER, DROP, GRANT, REVOKE or COMMENT. Locked until submit_diagnosis. No DML, no TRUNCATE, no other schemas.',
    input_schema: obj({ sql: { type: 'string' } }, ['sql']),
  },
  {
    name: 'run_migration_sql',
    description:
      'Same rules as db_execute, but recorded as a migration in the write-up. Use for the fix you would ship.',
    input_schema: obj({ sql: { type: 'string' } }, ['sql']),
  },
  {
    name: 'deploy_function',
    description:
      'Deploy full source for an edge function (slug: summarize or legacy-ping). Locked until submit_diagnosis.',
    input_schema: obj(
      { slug: { type: 'string', enum: [...DEPLOYABLE_SLUGS] }, source: { type: 'string' } },
      ['slug', 'source'],
    ),
  },
];

/* ------------------------------------------------------------------ SQL filters */

const READ_START = /^\s*(select|explain|with)\b/i;
const WRITE_WORDS =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|vacuum|call|do)\b/i;
const DDL_START = /^\s*(create|alter|drop|grant|revoke|comment)\b/i;
// Other schemas may not be modified. `auth.uid()` / `auth.jwt()` are the RLS helpers and stay usable.
const FORBIDDEN_SCHEMAS =
  /\b(auth|storage|realtime|payments|system|extensions|graphql|information_schema|net|cron|vault)\s*\.\s*(?!uid\s*\(|jwt\s*\()/i;
const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\btruncate\b/i, 'TRUNCATE is not allowed'],
  [/pg_terminate_backend|pg_cancel_backend/i, 'terminating sessions is not allowed'],
  [/pg_sleep/i, 'pg_sleep is not allowed'],
  [/\bdelete\s+from\s+(public\.)?audit_log\b/i, 'audit_log rows must not be deleted'],
  [
    /\bdrop\s+table\s+(if\s+exists\s+)?(public\.)?profiles\b/i,
    'the profiles table must not be dropped',
  ],
  [/\bdrop\s+(schema|database|role|owned)\b/i, 'only objects in public may be dropped'],
  [
    /\b(alter|create|drop)\s+(role|user|database|extension|schema)\b/i,
    'roles, databases, extensions and schemas are off limits',
  ],
  [/\bsecurity\s+definer\b/i, 'SECURITY DEFINER functions are not allowed here'],
];

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

/**
 * The statement's structure with quoted text removed: dollar-quoted bodies ($$…$$,
 * $tag$…$tag$), string literals, quoted identifiers and comments become a single space.
 * Statement counting and keyword checks run on this, so a function body full of `;` is one
 * statement and `select 'drop'` is a read. Deny-list checks still run on the full text, so a
 * dangerous call hidden in a function body is caught.
 */
export function sqlSkeleton(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const dollar = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out += ' ';
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j++;
      }
      i = j + 1;
      out += ' ';
      continue;
    }
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      out += ' ';
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Returns a rejection reason, or undefined when the SQL is acceptable read-mode SQL. */
export function readSqlViolation(sql: string): string | undefined {
  const s = stripTrailingSemicolon(sqlSkeleton(sql));
  if (!READ_START.test(s)) return 'db_query only accepts SELECT, EXPLAIN or WITH statements';
  if (s.includes(';')) return 'db_query accepts exactly one statement';
  if (WRITE_WORDS.test(s)) return 'db_query is read-only; write keywords are not allowed';
  return undefined;
}

/** Returns a rejection reason, or undefined when the SQL is acceptable DDL for public. */
export function writeSqlViolation(sql: string): string | undefined {
  const skeleton = stripTrailingSemicolon(sqlSkeleton(sql));
  const full = stripTrailingSemicolon(sql);
  if (!DDL_START.test(skeleton)) {
    return 'accepts CREATE, ALTER, DROP, GRANT, REVOKE or COMMENT';
  }
  if (skeleton.includes(';')) return 'accepts exactly one statement';
  if (FORBIDDEN_SCHEMAS.test(full)) return 'only the public schema may be modified';
  for (const [re, why] of DENY_PATTERNS) if (re.test(full)) return why;
  return undefined;
}

/* ------------------------------------------------------------------ result scrubbing */

const CATALOG_ID = /\b[FDC]0\d\b/g;

/** Tool output must never carry catalog ids, even if the victim somehow contained them. */
export function scrubCatalogIds(text: string): string {
  return text.replace(CATALOG_ID, '[redacted]');
}

export function truncate(text: string, tail = false, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const marker = `\n…[truncated ${text.length - max} chars]…\n`;
  return tail ? marker + text.slice(text.length - max) : text.slice(0, max) + marker;
}

/* ------------------------------------------------------------------ toolset */

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Set when the call was refused by the gate or a filter (never reached the CLI). */
  denied?: string;
  command?: string;
  ms: number;
}

export interface ToolsetOptions {
  /** The linked victim directory. Every CLI call runs here. */
  cwd: string;
  probeStatus: () => Promise<ProbeResult[]>;
  sink: EventSink;
  /** Restrict the tools this config may use (H1). Default: all. */
  allowedTools?: readonly ToolName[];
  /** Per-tool call caps (H1: db_query once). */
  maxCallsPerTool?: Partial<Record<ToolName, number>>;
  /** Result size cap; smaller on providers with tight per-minute token limits. */
  maxResultChars?: number;
}

export class HealerToolset {
  readonly diagnoses: Array<{ at: string; diagnosis: Diagnosis }> = [];
  readonly migrations: string[] = [];
  private readonly counts = new Map<ToolName, number>();
  private unlocked = false;

  constructor(private readonly opts: ToolsetOptions) {}

  get definitions(): Anthropic.Tool[] {
    const allowed = this.opts.allowedTools;
    return allowed
      ? TOOL_DEFINITIONS.filter((t) => allowed.includes(t.name as ToolName))
      : TOOL_DEFINITIONS;
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  get lastDiagnosis(): Diagnosis | undefined {
    return this.diagnoses.at(-1)?.diagnosis;
  }

  get firstDiagnosisAt(): string | undefined {
    return this.diagnoses[0]?.at;
  }

  async execute(name: string, rawInput: unknown): Promise<ToolOutcome> {
    const started = Date.now();
    const outcome = await this.executeInner(name, rawInput);
    const ms = Date.now() - started;
    const content = truncate(
      scrubCatalogIds(outcome.content),
      name === 'get_logs',
      this.opts.maxResultChars ?? MAX_RESULT_CHARS,
    );
    const result: ToolOutcome = { ...outcome, content, ms };
    await this.opts.sink.record('tool_result', {
      name,
      ok: !result.isError,
      denied: result.denied ?? null,
      ms,
      chars: content.length,
      preview: content.slice(0, 400),
    });
    return result;
  }

  private async executeInner(name: string, rawInput: unknown): Promise<Omit<ToolOutcome, 'ms'>> {
    if (!ALL_TOOL_NAMES.includes(name as ToolName)) return deny(`unknown tool ${name}`);
    const tool = name as ToolName;
    if (this.opts.allowedTools && !this.opts.allowedTools.includes(tool)) {
      return deny(`${tool} is not available in this configuration`);
    }
    const cap = this.opts.maxCallsPerTool?.[tool];
    const used = this.counts.get(tool) ?? 0;
    if (cap !== undefined && used >= cap)
      return deny(`${tool} may be called at most ${cap} time(s)`);

    const parsed = inputs[tool].safeParse(rawInput ?? {});
    if (!parsed.success) {
      return deny(
        `invalid input for ${tool}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
      );
    }
    const input = parsed.data as Record<string, unknown>;
    await this.opts.sink.record('tool_call', { name: tool, input: redactForLog(tool, input) });

    if ((WRITE_TOOLS as readonly string[]).includes(tool) && !this.unlocked) {
      return deny('write tools are locked until you call submit_diagnosis');
    }
    this.counts.set(tool, used + 1);

    switch (tool) {
      case 'probe_status': {
        const results = await this.opts.probeStatus();
        return ok(JSON.stringify(results, null, 1));
      }
      case 'get_metadata':
        return this.cli(['metadata']);
      case 'diagnose':
        return this.cli(['diagnose', String(input.kind)]);
      case 'diagnose_ai':
        return this.cli(['diagnose', '--ai', String(input.question)], 180_000);
      case 'get_logs':
        return this.cli(['logs', String(input.source), '--limit', String(input.limit ?? 50)]);
      case 'db_policies':
        return this.cli(['db', 'policies']);
      case 'db_indexes':
        return this.cli(['db', 'indexes']);
      case 'db_triggers':
        return this.cli(['db', 'triggers']);
      case 'db_functions':
        return this.cli(['db', 'functions']);
      case 'db_tables':
        return this.cli(['db', 'tables']);
      case 'list_functions':
        return this.cli(['functions', 'list']);
      case 'get_function_source':
        return this.cli(['functions', 'code', String(input.slug)]);
      case 'db_query': {
        const violation = readSqlViolation(String(input.sql));
        if (violation) return deny(violation);
        return this.cli(['db', 'query', String(input.sql)]);
      }
      case 'submit_diagnosis': {
        const diagnosis = parsed.data as Diagnosis;
        const at = new Date().toISOString();
        this.diagnoses.push({ at, diagnosis });
        this.unlocked = true;
        await this.opts.sink.record('diagnosis', { ...diagnosis, revision: this.diagnoses.length });
        return ok(`diagnosis #${this.diagnoses.length} recorded; write tools are now unlocked`);
      }
      case 'db_execute':
      case 'run_migration_sql': {
        const sql = String(input.sql);
        const violation = writeSqlViolation(sql);
        if (violation) return deny(`${tool} ${violation}`);
        if (tool === 'run_migration_sql') this.migrations.push(sql);
        const res = await this.cli(['db', 'query', stripTrailingSemicolon(sql)]);
        await this.opts.sink.record('fix_applied', { tool, sql, ok: !res.isError });
        return res;
      }
      case 'deploy_function': {
        const dir = mkdtempSync(path.join(tmpdir(), 'bmb-deploy-'));
        const file = path.join(dir, `${String(input.slug)}.ts`);
        writeFileSync(file, String(input.source));
        const res = await this.cli(
          ['functions', 'deploy', String(input.slug), '--file', file],
          180_000,
        );
        await this.opts.sink.record('fix_applied', { tool, slug: input.slug, ok: !res.isError });
        return res;
      }
    }
  }

  private async cli(args: string[], timeoutMs = 120_000): Promise<Omit<ToolOutcome, 'ms'>> {
    const res = await runInsforge(args, { cwd: this.opts.cwd, timeoutMs });
    const body = res.json !== undefined ? JSON.stringify(res.json, null, 1) : res.stdout;
    if (!res.ok) {
      return {
        content: `error: ${res.error ?? 'command failed'}\n${body.slice(0, 2000)}`,
        isError: true,
        command: res.command,
      };
    }
    return { content: body, isError: false, command: res.command };
  }
}

function ok(content: string): Omit<ToolOutcome, 'ms'> {
  return { content, isError: false };
}

function deny(reason: string): Omit<ToolOutcome, 'ms'> {
  return { content: `denied: ${reason}`, isError: true, denied: reason };
}

/** Function sources can be long; keep the event payload small. */
function redactForLog(tool: ToolName, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'deploy_function') {
    return { slug: input.slug, source: `${String(input.source).slice(0, 300)}…` };
  }
  return input;
}
