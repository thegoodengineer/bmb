# InsForge verification notes

Every `⚠ VERIFY` item from the original spec, checked on 2026-09-22 against:

- `npx @insforge/cli --help` and per-subcommand help, CLI **0.2.8**
- the agent skills at `github.com/insforge/agent-skills` (`insforge`, `insforge-cli`, `insforge-debug`), installed with `npx skills add`
- a throwaway `npx @insforge/cli local start` instance, backend **v2.3.2**, Postgres 15.18
- `@insforge/sdk` **1.5.2** type declarations and a handful of SDK probe scripts

Where the platform differs from the spec, the platform wins and `SPEC.md` was updated.

## Summary table

| # | Spec item | Verdict | Confirmed behaviour |
|---|---|---|---|
| 1 | Healer model `claude-sonnet-4-6` | valid, superseded | `claude-sonnet-4-6` still exists ($3 / $15 per MTok). Current generation is `claude-sonnet-5` ($2 / $10). **Decision: `claude-sonnet-5` for healer and judge.** |
| 2 | `compute deploy` for the referee | confirmed | `compute deploy <dir> --name <n>` (source mode, needs `flyctl` on PATH, remote build) or `compute deploy --image <url> --name <n>` (nothing local). Flags: `--port`, `--cpu`, `--memory`, `--region`, `--env`/`--env-file`, `--always-on`. Default for new services is always-on. |
| 3 | `insforge.toml` format via `config plan` | confirmed, narrow | TOML manages only: auth redirect URLs, email verification flags, password policy, SMTP, storage max file size, realtime/schedule retention, deployment subdomain. **Not** tables, functions, secrets, channels. `config apply --json` needs `-y`/`--auto-approve`. |
| 4 | Auth users table for `profiles.id` | confirmed | `auth.users(id)`. FK references are allowed; never modify `auth.*`. |
| 5 | Role names and JWT claim function | confirmed | Runtime roles `anon`, `authenticated`; CLI `db query` and migrations run as `project_admin`. `auth.uid()` returns the caller's uuid and `NULL` for anon. See evidence A. |
| 6 | Edge-function handler signature and caller JWT | **corrected** | Docs (cloud, Deno Subhosting): ESM `export default async function (req: Request): Promise<Response>`, `import { createClient } from 'npm:@insforge/sdk'`. Caller JWT: `req.headers.get('Authorization')` → `createClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL'), accessToken })`. The **local** runtime differs: see evidence B. |
| 7 | Create a user non-interactively | confirmed | SDK `auth.signUp({ email, password })` with the anon key returns `accessToken` when `requireEmailVerification=false` (local default). `createAdminClient({ apiKey }).auth.signUp({ …, autoConfirm: true })` yields `emailVerified: true`. There is no admin "create user" endpoint in the SDK. |
| 8 | `functions deploy` from a path | confirmed | `functions deploy <slug> --file <path> [--name] [--description]`; creates or updates; JSON returns `function.status: "active"`. |
| 9 | Log source names | confirmed | `insforge.logs`, `postgREST.logs`, `postgres.logs`, `function.logs`, `function-deploy.logs` (case-insensitive). `--limit <n>` (default 20), `--json` → `{ logs: [{ id, timestamp, eventMessage, body: { level, message, metadata } }], total }`. |
| 10 | `functions list` / `functions get` | **corrected** | It is `functions code <slug>`. `functions list --json` → `{ functions: [{ id, slug, name, status, deployedAt }], runtime: { status }, deploymentUrl }`. |
| 11 | Realtime API for the web | confirmed | Needs a row in `realtime.channels (pattern, enabled)`. Then anon `realtime.connect()` + `subscribe('name')` works, `on(event, cb)` receives payload with `meta.channel` (prefixed `realtime:`). Server side: `select realtime.publish(channel, event, jsonb)` from a trigger. See evidence C. |
| 12 | Views over PostgREST, realtime on tables | confirmed | Views in `public` with grants are served like tables. Realtime does **not** stream table changes; you publish from a trigger. |
| 13 | `db migrations up --all` | confirmed | Files `migrations/<YYYYMMDDHHMMSS>_<kebab-name>.sql`, created with `db migrations new <name>`. No `BEGIN/COMMIT`. `up --all` is idempotent. `--json` returns applied statements. |
| 14 | Web deploy path | confirmed | `deployments deploy <dir> [--env json]` deploys to Vercel through InsForge; `deployments env set K V` persists env. Built-in excludes for `node_modules`, `.next`, `.env*`. |
| 15 | `branch reset` for per-round reset | **rejected** | Cloud-only, 2–5 min, rewinds the whole DB and edge functions; also branches cost an EC2 each. Not viable between rounds. Reset = reference fixes + idempotent seed. |
| 16 | `diagnose --ai`, `diagnose advisor`, `diagnose metrics` | **cloud-only** | On local: `--ai` → `{"error":"forbidden"}`, advisor → `{ scan: null, issues: [] }`, metrics → "requires InsForge Platform login". Also unavailable on backends linked via `--api-key`. |

## Evidence

### A. Roles and `auth.uid()`

RPC `zz_whoami()` = `current_user || current_setting('request.jwt.claims')`, called through the SDK:

```
whoami FRESH anon : "anon | {\"iat\":1790064299,\"role\":\"anon\"}"
whoami as user    : "authenticated | {\"email\":\"probe3+…@bmb.local\",…"
auth.uid() user   : "f824cf29-e19f-4d20-ac58-cf6c81820a26"   (equals the signUp user id)
auth.uid() anon   : "<null>"
whoami no key     : 401 AUTH_INVALID_CREDENTIALS "No token provided"
```

### B. Edge functions: local runtime ≠ cloud docs

Four sources deployed to the local instance and invoked:

```
A  JS, `export default`                     → 500 "Unexpected token 'export'"
B  JS, `module.exports = async (req) => …`  → 200
C  TS, `export default`                     → 500 "Unexpected token 'export'"
D  TS, `import … from 'npm:@insforge/sdk'`  → 500 "Cannot use import statement outside a module"
```

The local runtime (`functions/worker-template.js` in the checkout) wraps the source with `new Function('exports','module','createClient','Deno',…)`, so only CommonJS works locally and `createClient` is an injected global. Inside a function, `Deno.env.get()` exposes `INSFORGE_BASE_URL`, `ANON_KEY`, `API_KEY`, `JWT_SECRET` and any `secrets add` value:

```
"env": { "INSFORGE_BASE_URL": "http://localhost:7130", "ANON_KEY": "anon_…", "API_KEY": "ik_60…",
         "JWT_SECRET": "c00e5…", "ZZ_CUSTOM": "hello…" }
```

Local gotcha: `INSFORGE_BASE_URL` is `http://localhost:7130`, unreachable from inside the Deno container (`Connection refused`). The cloud runtime is Deno Subhosting (`functions list` reports a `deploymentUrl`, `function-deploy.logs` has build logs), where the documented ESM form is the contract. **Decision: `summarize` is written in the documented ESM form and developed against the cloud project.**

CLI `functions invoke` sends the project **API key** as the bearer, so P5 must invoke through the SDK as the probe user.

### C. Realtime

```
anon subscribe bmb:test  → {"ok":true,"channel":"bmb:test","presence":{"members":[…]}}
user publish             → delivered to the anon subscriber in 210 ms
select realtime.publish('bmb:sql','sql_event','{"n":42}')  → delivered to anon (senderType "system")
```

Without a matching `realtime.channels` row the subscribe returns `REALTIME_UNAUTHORIZED`.

### D. `db query`

- Runs as `project_admin`; multi-statement input is accepted.
- **No confirmation on destructive DDL**: `drop index` / `drop policy` returned exit 0 with no prompt. The human-in-the-loop guard is opt-in (`link --guard`). Fine for the injector; the healer's write tool needs its own allow-list.
- Errors are returned on stdout with **exit code 0**: `{"error":"relation \"nope_table\" does not exist…","code":"DATABASE_VALIDATION_ERROR"}`. The CLI wrapper must parse for `error`.
- Transaction control is rejected: `{"error":"Transaction control statements are not allowed.","code":"FORBIDDEN"}`.
- `explain …` and `with … select` work (read-mode forms for the healer).
- `pg_stat_statements` is not installed locally, so slow-query stats (decoy D03) only surface via the cloud advisor.
- `db rpc <fn> --json` prints the bare return value (`2`).

Catalog command shapes (all `--json`):

```
db policies  → { policies: [{ tableName, policyName, cmd, roles: "{authenticated}", qual, withCheck }] }
db indexes   → { indexes:  [{ tableName, indexName, indexDef, isUnique, isPrimary }] }
db triggers  → { triggers: [{ tableName, triggerName, actionTiming, eventManipulation, actionOrientation, actionCondition, actionStatement }] }
db functions → { functions:[{ functionName, functionDef, kind }] }
db tables    → [ "zz_probe" ]
```

### E. Default grants

New `public` tables get `SELECT, INSERT, UPDATE, DELETE` for **both** `anon` and `authenticated` automatically (verified via `information_schema.role_table_grants`). RLS still gates rows. F03 (revoke) is therefore a real fault, and the victim schema must not assume grants are absent.

### F. `db export` / `db import` as a reset mechanism — rejected

- `db export -o file` writes a JSON envelope `{"format":"sql","data":"…"}` rather than raw SQL when `--json` is passed, and the dump contains policies, triggers, functions and data but **no indexes and no grants**.
- `db import file --truncate` → `{"error":"FORBIDDEN"}` on local.

### G. Local instance facts

- `local start` fetches `deploy/setup.sh`, pulls `insforge-oss:latest`, `postgres:v15.13.4`, `postgrest:v12.2.12`, `deno:alpine-2.0.6`; first start took ~5 min here. Ports 7130/7131/7133/5432/5430, one instance per directory.
- `function.logs` stays empty locally even after invocations; `function-deploy.logs` → `LOG_NOT_FOUND`. `insforge.logs` works and records `POST /functions/<slug> 500`.
- `metadata --json` sections: `auth` (`requireEmailVerification`, `passwordMinLength`, …), `database.tables`, `storage`, `functions`, `realtime.channels`.

## Decisions taken from these notes

1. Develop Phases 1–7 against the cloud project `bmb-victim` (`y2z8xzxf.us-east`, created 2026-09-22). Local is optional for fast injector iteration only.
2. Healer and judge model: `claude-sonnet-5`.
3. `summarize` in the documented ESM form.
4. Between-round reset: reference fixes for every fault in the round, then an idempotent seed; verified by the same `artifactPresent()` checks the oracle uses.
5. The healer's `diagnose_ai`, `diagnose('advisor')` and `diagnose('metrics')` tools are real only on cloud; H1 (`diagnose-only`) is cloud-only by construction.

## Candidate upstream feedback (for Abhijeet to file)

- Skill/docs show ESM edge functions; the local runtime only executes CommonJS. `--component skills --area functions`.
- `db export -o` writes a JSON envelope instead of SQL under `--json`; dumps omit indexes and grants. `--component cli --area db`.
- `db query --json` reports errors with exit code 0. `--component cli --area db`.
