import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Thin, typed wrapper around the InsForge CLI.
 *
 * Every call is `node <@insforge/cli bin> <args> --json`, spawned WITHOUT a shell and with
 * `cwd` pinned to the linked project directory. No shell means SQL and JSON arguments need
 * no quoting and cannot be used for injection. The CLI version is pinned in package.json,
 * so this is the same code `npx @insforge/cli` runs, minus the network resolution step.
 *
 * Findings this wrapper encodes (docs/INSFORGE_NOTES.md §D):
 *  - `db query --json` reports errors on stdout with exit code 0, so we parse for `error`.
 *  - some commands print more than one JSON document (e.g. `functions invoke` on HTTP 500),
 *    so we parse every top-level JSON value and treat any `{error}` as failure.
 */

export interface CliOptions {
  /** Directory the CLI runs in; must be linked (`.insforge/project.json`). */
  cwd: string;
  timeoutMs?: number;
}

export interface CliResult {
  /** Human-readable form of what ran, for logs and the heal log. */
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** First JSON document on stdout, if any. */
  json: unknown;
  /** Every JSON document on stdout. */
  documents: unknown[];
  /** Error message, from `{error}` JSON, stderr, or a non-zero exit. */
  error: string | undefined;
  ok: boolean;
}

const require = createRequire(import.meta.url);

function resolveCliBin(): string {
  const pkgPath = require.resolve('@insforge/cli/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.insforge;
  if (!bin) throw new Error('@insforge/cli: no bin entry in package.json');
  return path.join(path.dirname(pkgPath), bin);
}

let cliBin: string | undefined;

/** Parse every top-level JSON value in a string (tolerates interleaved plain-text lines). */
export function parseJsonDocuments(text: string): unknown[] {
  const docs: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.slice(i).search(/[[{]/);
    if (start < 0) break;
    const from = i + start;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = from; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      docs.push(JSON.parse(text.slice(from, end)));
    } catch {
      // not JSON after all; skip this opener
    }
    i = end;
  }
  return docs;
}

function errorOf(doc: unknown): string | undefined {
  if (doc && typeof doc === 'object' && 'error' in doc) {
    const { error, code } = doc as { error: unknown; code?: unknown };
    const msg = typeof error === 'string' ? error : JSON.stringify(error);
    return typeof code === 'string' ? `${code}: ${msg}` : msg;
  }
  return undefined;
}

function quoteForDisplay(a: string): string {
  return /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export async function runInsforge(args: string[], opts: CliOptions): Promise<CliResult> {
  cliBin ??= resolveCliBin();
  const bin = cliBin;
  const fullArgs = args.includes('--json') ? args : [...args, '--json'];
  const command = `npx @insforge/cli ${fullArgs.map(quoteForDisplay).join(' ')}`;
  const started = Date.now();

  return new Promise<CliResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    const finish = (exitCode: number | null, spawnError: string | undefined): CliResult => {
      const documents = parseJsonDocuments(stdout);
      const docError = documents.map(errorOf).find((e) => e !== undefined);
      const exitError =
        exitCode !== 0 ? stderr.trim() || `exit code ${String(exitCode)}` : undefined;
      const error = spawnError ?? docError ?? exitError;
      return {
        command,
        args: fullArgs,
        exitCode,
        stdout,
        stderr,
        ms: Date.now() - started,
        json: documents[0],
        documents,
        error,
        ok: exitCode === 0 && error === undefined,
      };
    };

    const child = spawn(process.execPath, [bin, ...fullArgs], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(finish(null, err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(finish(code, undefined));
    });
  });
}

/** `db query` rows, typed by the caller. Throws on CLI error. */
export async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  opts: CliOptions,
): Promise<T[]> {
  const res = await runInsforge(['db', 'query', sql], opts);
  if (!res.ok) throw new Error(`db query failed: ${res.error}\n${sql.slice(0, 300)}`);
  const rows = (res.json as { rows?: T[] } | undefined)?.rows;
  return rows ?? [];
}
