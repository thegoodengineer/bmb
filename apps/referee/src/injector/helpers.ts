import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REFEREE_ROOT } from '../env.js';
import { runInsforge } from '../insforge-cli.js';
import type { InjectorContext } from './types.js';

/** Run one SQL statement (or several separated by `;`) as project_admin; throws on error. */
export async function sql<T = Record<string, unknown>>(
  ctx: InjectorContext,
  statement: string,
): Promise<T[]> {
  const res = await runInsforge(['db', 'query', statement], { cwd: ctx.cwd });
  ctx.log(res.command);
  if (!res.ok) throw new Error(`db query failed: ${res.error}\n${statement.slice(0, 400)}`);
  return ((res.json as { rows?: T[] } | undefined)?.rows ?? []) as T[];
}

/** Scalar helper: first column of the first row. */
export async function scalar<T>(ctx: InjectorContext, statement: string): Promise<T | undefined> {
  const rows = await sql<Record<string, T>>(ctx, statement);
  const first = rows[0];
  if (!first) return undefined;
  return Object.values(first)[0];
}

export async function exists(ctx: InjectorContext, predicateSql: string): Promise<boolean> {
  const v = await scalar<boolean | string>(ctx, `select exists (${predicateSql}) as present`);
  return v === true || v === 't' || v === 'true';
}

/** Assets shipped with the referee (fault sources for edge functions). */
export function assetPath(...parts: string[]): string {
  return path.join(REFEREE_ROOT, 'assets', ...parts);
}

export function readAsset(...parts: string[]): string {
  return readFileSync(assetPath(...parts), 'utf8');
}

/** The good summarize source lives in the victim directory. */
export function victimFunctionPath(ctx: InjectorContext, slug: string): string {
  return path.join(ctx.cwd, 'functions', slug, 'index.ts');
}

export interface DeployResult {
  ok: boolean;
  status: string | undefined;
  attempts: number;
  detail: string | undefined;
}

/**
 * `functions deploy` with retries: the cloud build occasionally fails with a 502 from the
 * build service and succeeds on the next attempt (docs/INSFORGE_NOTES.md §H).
 */
export async function deployFunction(
  ctx: InjectorContext,
  slug: string,
  file: string,
  attempts = 6,
): Promise<DeployResult> {
  // The build service intermittently answers {"error":"Function deployment failed"} with no
  // build logs for a few minutes at a time; the same source deploys fine afterwards. Back off
  // 10/20/40/60/60 s so one bad window does not fail a round.
  const backoffMs = [10_000, 20_000, 40_000, 60_000, 60_000];
  let last: DeployResult = { ok: false, status: undefined, attempts: 0, detail: undefined };
  for (let i = 1; i <= attempts; i++) {
    const res = await runInsforge(['functions', 'deploy', slug, '--file', file], {
      cwd: ctx.cwd,
      timeoutMs: 180_000,
    });
    ctx.log(res.command);
    const doc = res.json as
      | { success?: boolean; deployment?: { status?: string; buildLogs?: unknown } }
      | undefined;
    const status = doc?.deployment?.status;
    last = {
      ok: res.ok && doc?.success === true && status === 'success',
      status,
      attempts: i,
      detail:
        res.error ??
        (status !== 'success' ? JSON.stringify(doc?.deployment).slice(0, 300) : undefined),
    };
    if (last.ok) return last;
    if (i < attempts) await new Promise((r) => setTimeout(r, backoffMs[i - 1] ?? 60_000));
  }
  return last;
}

export async function deployFunctionOrThrow(
  ctx: InjectorContext,
  slug: string,
  file: string,
): Promise<void> {
  const r = await deployFunction(ctx, slug, file);
  if (!r.ok)
    throw new Error(`functions deploy ${slug} failed after ${r.attempts} attempts: ${r.detail}`);
}

export async function functionCode(
  ctx: InjectorContext,
  slug: string,
): Promise<string | undefined> {
  const res = await runInsforge(['functions', 'code', slug], { cwd: ctx.cwd });
  ctx.log(res.command);
  if (!res.ok) return undefined;
  const code = (res.json as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function functionExists(ctx: InjectorContext, slug: string): Promise<boolean> {
  const res = await runInsforge(['functions', 'list'], { cwd: ctx.cwd });
  ctx.log(res.command);
  const fns = (res.json as { functions?: { slug?: string }[] } | undefined)?.functions ?? [];
  return fns.some((f) => f.slug === slug);
}

export async function deleteFunction(ctx: InjectorContext, slug: string): Promise<void> {
  if (!(await functionExists(ctx, slug))) return;
  const res = await runInsforge(['functions', 'delete', slug, '-y'], { cwd: ctx.cwd });
  ctx.log(res.command);
  if (!res.ok) throw new Error(`functions delete ${slug} failed: ${res.error}`);
}
