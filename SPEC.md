# Break My Backend — working spec

## 0. Who you are and how you work

You are the lead engineer on **Break My Backend**: a public, live, adversarial mini-benchmark for agent-native backends, built on InsForge. Strangers compose faults against a real InsForge app. An AI healer must diagnose and repair it. The game grades both the *diagnosis* and the *fix*, because — unlike production — it knows the ground truth (the attacker chose the fault).

The person you are working with is Abhijeet (GitHub `thegoodengineer`). He is the product owner. He has merged PRs into InsForge already and wants this project to be good enough that the InsForge founders notice it. Quality bar: a founder will open the repo. It has to look like something an engineer understands, not something that was vibe-coded.

### Operating rules (non-negotiable)

1. **Never guess an InsForge API.** Before writing any code that touches InsForge (CLI flags, SDK method names, realtime API, edge-function signature, branching commands, auth flows), read the source of truth first:
   - `npx @insforge/cli --help` and `npx @insforge/cli <subcommand> --help`
   - `npx @insforge/cli docs` (needs a linked directory; features: db, storage, functions, auth, ai, realtime, instructions)
   - The agent skills the CLI installs when you link/create (`.agents/skills/insforge*`), also `npx skills add https://github.com/insforge/agent-skills --skill insforge-debug`
   - `npx @insforge/cli metadata --json` for the live schema/functions/channels
   Everything that was tagged `⚠ VERIFY` in the original spec has been checked; the answers and evidence live in `docs/INSFORGE_NOTES.md`. If the platform differs from this file, follow the platform and update both files.
2. **Real terminal output or it didn't happen.** Every time you claim something works (probe green, fault injected, fix applied, test passed), paste the actual command and its actual output. Never summarize a result you did not observe. If a command fails, show the failure.
3. **Always `npx @insforge/cli`, never a global install.** Pass `--json` whenever a command supports it and the output is parsed programmatically. `db query --json` reports errors on stdout with exit code 0 — parse for an `error` key.
4. **Commit at the end of every phase** with a conventional commit message (`feat(victim): ...`, `feat(healer): ...`). Do not move to the next phase until the current phase's acceptance gate is met and shown.
5. **No secrets in the repo.** All keys go in `.env` files that are gitignored. Provide `.env.example` for every package. `.insforge/project.json` contains the admin key and is gitignored.
6. **The healer must never see ground truth.** Enforced architecturally (Section 4), not by prompt. Write tests that prove it.
7. **Faults, not symptoms.** Every fault in the catalog must be a real defect in the backend state that has a real fix. Never "kill the container" or "block the network".
8. **Healing is verified by state, not by alerts clearing.** A round is healed only when the synthetic user probes pass AND the specific injected artifact is gone. `diagnose` returning clean is not the success signal.
9. **Ask before you assume on product decisions.** If something is ambiguous or conflicts with what the platform allows, stop and ask Abhijeet one precise question.
10. **Stack is fixed** (Section 2). Do not introduce a different framework, ORM, or state library without asking.

---

## 1. Concept, in one screen

- **Victim**: a deliberately boring notes app on InsForge (Postgres + RLS + one edge function + one RPC). Boring on purpose; the drama is in the breaking.
- **Attacker**: any anonymous visitor. Picks from a curated fault menu (never free-form SQL). Can add **decoys** (harmless noise) and fire **combos** (two real faults with overlapping symptoms).
- **Referee**: a trusted server process. Injects faults, runs synthetic-user probes every few seconds, decides when a round is healed, runs the diagnosis judge, computes scores, and resets the victim between rounds.
- **Healer**: an LLM agent (an LLM driven through the Anthropic SDK) with a *constrained* toolset over the victim's InsForge CLI. It sees only what a real on-call engineer would see: logs, metadata, policies, diagnose output. It must `submit_diagnosis` before it is allowed to use any write tool.
- **Web**: one page. Dark navy / gold, terminal aesthetic. Attack panel, live heal log, scoreboard.
- **Scoring**: heal rate, time-to-diagnose (TTD), time-to-mitigate (TTM), diagnosis accuracy by fault class (3-dimension checklist judge), and the **"lucky fix" rate** — P(healed | wrong diagnosis).

Research the mechanics are borrowed from (cite in README): SREGym (arXiv 2605.07161) for faults-not-symptoms, noise/decoys, compound failures, state-based mitigation oracle, checklist LLM judge, and reward-hacking protection; ITBench-AA (Artificial Analysis / IBM) for precision-at-full-recall style strictness.

---

## 2. Stack (fixed)

| Layer | Choice |
|---|---|
| Monorepo | `pnpm` workspaces, TypeScript strict everywhere, Node 20+ (dev machine: Node 22, pnpm 12) |
| Web | Next.js 15 App Router, TypeScript, Tailwind CSS v4, no component library |
| Referee + Healer | Node TypeScript workers run with `tsx` (dev) / compiled with `tsc` (prod) |
| LLM | `@anthropic-ai/sdk`. Healer model: `claude-sonnet-5`. Judge model: same, separate system prompt, temperature 0. |
| Backend | InsForge cloud. **Two projects**: `bmb-victim` (the thing that gets broken; `y2z8xzxf.us-east`, created 2026-09-22) and `bmb-control` (rounds, events, scores — the healer has no credentials for this; created in Phase 5). A `local start` instance is optional for fast injector iteration only — `diagnose --ai`, advisor, metrics and `function.logs` are cloud-only, and the local edge runtime only executes CommonJS. |
| Validation | `zod` for every event payload and every tool input |
| Tests | `vitest` |
| Lint/format | `biome` |
| Process manager (prod) | Referee and healer run in one Node process (`apps/referee`) as an InsForge compute service (`npx @insforge/cli compute deploy --image … --name bmb-referee`, always-on by default), fallback pm2 on a VPS |

---

## 3. Repository layout

```
break-my-backend/
├── SPEC.md                      # this file
├── README.md                      # written LAST, as a case study (Section 12)
├── package.json                   # pnpm workspaces root
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
├── .gitignore
├── .env.example                   # root: ANTHROPIC_API_KEY
│
├── packages/
│   └── shared/                    # types + fault catalog + zod schemas; imported by everything
│       ├── src/
│       │   ├── faults.ts          # THE FAULT CATALOG (Section 6) — data only, no injection code
│       │   ├── events.ts          # zod schemas for rounds/events/scores
│       │   ├── scoring.ts         # pure functions: points, tiers, aggregates
│       │   └── index.ts
│       └── package.json           # builds to dist/; consumers import the built output
│
├── victim/                        # InsForge project "bmb-victim" — linked dir (.insforge/ gitignored)
│   ├── insforge.toml              # config-as-code (auth flags only; see docs/INSFORGE_NOTES.md)
│   ├── migrations/                # <YYYYMMDDHHMMSS>_<kebab-name>.sql, applied with `db migrations up --all`
│   ├── functions/
│   │   └── summarize/index.ts     # the ONE edge function (good version), ESM, deployed with --file
│   └── README.md
│
├── control/                       # InsForge project "bmb-control" — linked dir
│   ├── migrations/
│   └── README.md
│
├── apps/
│   ├── referee/                   # trusted worker: injector + probes + oracle + judge + healer runner
│   │   ├── src/
│   │   │   ├── index.ts           # main loop
│   │   │   ├── insforge-cli.ts    # thin typed wrapper around `npx @insforge/cli ... --json` (spawn, cwd=victim/)
│   │   │   ├── injector/          # one file per fault: inject(), referenceFix(), artifactPresent()
│   │   │   ├── probes.ts          # synthetic user suite (Section 5.6)
│   │   │   ├── oracle.ts          # healed? = probes green ×3 AND artifactPresent()==false for all faults
│   │   │   ├── judge.ts           # 9-question checklist judge (Section 8)
│   │   │   ├── reset.ts           # between-round reset: reference fixes + idempotent seed
│   │   │   ├── control-db.ts      # writes rounds/events/scores to bmb-control
│   │   │   └── healer/
│   │   │       ├── runner.ts
│   │   │       ├── tools.ts       # the constrained tool set (Section 7.3) + allow/deny enforcement
│   │   │       ├── prompts/base.md, with-skill.md
│   │   │       └── configs.ts     # H1 / H2 / H3
│   │   ├── test/
│   │   ├── .env.example
│   │   └── package.json
│   │
│   └── web/                       # Next.js
│       ├── app/                   # layout, page, api/attack, api/scoreboard
│       ├── components/
│       ├── lib/                   # insforge.ts (anon client + realtime), session.ts
│       ├── styles/globals.css     # design tokens (Section 9.1)
│       ├── .env.example
│       └── package.json
│
└── docs/
    ├── INSFORGE_NOTES.md          # every verified platform fact, with evidence
    ├── ARCHITECTURE.md
    ├── FAULT_CATALOG.md           # generated from packages/shared/src/faults.ts
    ├── SCORING.md
    └── MISSES.md
```

---

## 4. Trust boundaries (this is the most important section)

```
┌─────────────── attacker (browser, anonymous) ───────────────┐
│  can: enqueue a round with fault ids from the catalog        │
│  cannot: run SQL, see healer credentials, see anything else  │
└──────────────────────┬───────────────────────────────────────┘
                       │ POST /api/attack  (rate-limited)
                       ▼
┌──────────────── apps/web (Next.js) ──────────────────────────┐
│  has: bmb-control ANON key only                              │
│  writes: rounds(status='queued')                             │
│  reads: events, scoreboard views (realtime)                  │
└──────────────────────┬───────────────────────────────────────┘
                       │ realtime / polling
                       ▼
┌──────────────── apps/referee (trusted) ──────────────────────┐
│  has: bmb-control API key, bmb-victim API key,               │
│       ANTHROPIC_API_KEY                                      │
│  does: inject, probe, judge, score, reset, run the healer    │
│                                                              │
│   ┌──────── healer (LLM inside referee process) ─────────┐   │
│   │ receives: ONLY the tool set in Section 7.3           │   │
│   │ tool set is scoped to bmb-victim via the CLI wrapper │   │
│   │ receives NO: fault ids, catalog, control creds,      │   │
│   │   filesystem, shell, referee source                  │   │
│   │ must call submit_diagnosis before any write tool     │   │
│   └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- The healer LLM's tool implementations are the ONLY code path that talks to `bmb-victim` on the healer's behalf, and they are hard-coded to the victim project's linked directory. There is no "run arbitrary command" tool.
- The fault catalog (`packages/shared/src/faults.ts`) is imported by referee and web, **never** stringified into any healer prompt or tool result. A vitest greps every healer prompt file and every tool result serializer for fault ids (`F0`, `D0`, `C0`) and fails if found.
- The `events` table stores healer tool calls/results. The healer cannot read the `events` table (it has no control-project tool).
- Attackers get a random, non-guessable `attacker_session` cookie. No login required. Optional display handle (3–16 chars, sanitized) for the Wall of Fame.

---

## 5. The victim app (`victim/`)

### 5.1 Schema

```sql
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique,
  created_at timestamptz not null default now()
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_owner_created_idx on public.notes (owner_id, created_at desc);

create table public.audit_log (                 -- exists so decoys have somewhere harmless to write
  id bigserial primary key,
  at timestamptz not null default now(),
  level text not null,
  message text not null
);
```

### 5.2 Policies

Roles are `anon` / `authenticated`; the claim function is `auth.uid()` (verified). InsForge grants full DML on new public tables to both roles automatically, so the migration **revokes** first and grants back exactly what the app needs — otherwise F03 would be a no-op and anon would have table privileges.

```sql
alter table public.notes enable row level security;
alter table public.profiles enable row level security;
alter table public.audit_log enable row level security;

create policy notes_select_own on public.notes for select to authenticated using (owner_id = (select auth.uid()));
create policy notes_insert_own on public.notes for insert to authenticated with check (owner_id = (select auth.uid()));
create policy notes_update_own on public.notes for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy notes_delete_own on public.notes for delete to authenticated using (owner_id = (select auth.uid()));
create policy profiles_select_all on public.profiles for select to authenticated using (true);

revoke all on public.notes, public.profiles, public.audit_log from anon, authenticated;
grant select, insert, update, delete on public.notes to authenticated;
grant select on public.profiles to authenticated;
```

### 5.3 Functions

```sql
create or replace function public.note_count() returns integer
language sql security invoker stable as $$
  select count(*)::int from public.notes where owner_id = (select auth.uid());
$$;
revoke execute on function public.note_count() from public, anon;
grant execute on function public.note_count() to authenticated;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create trigger notes_touch before update on public.notes for each row execute function public.touch_updated_at();
```

### 5.4 Edge function `victim/functions/summarize/index.ts`

Documented cloud form (Deno Subhosting):

```ts
import { createClient } from 'npm:@insforge/sdk';
export default async function (req: Request): Promise<Response> { … }
```

Caller JWT comes from `req.headers.get('Authorization')`; read the note **as the caller** with `createClient({ baseUrl: Deno.env.get('INSFORGE_BASE_URL'), accessToken })` so RLS applies. Accepts `{ noteId }`, returns `{ summary: first 120 chars of body, words: n }`. 401 if no JWT, 404 if the note is not visible. No AI call. (The local Docker runtime only executes `module.exports` CommonJS — see `docs/INSFORGE_NOTES.md` §B — which is one reason development targets the cloud project.)

### 5.5 Seed + probe user
- The referee's seed step creates the probe user (`probe@bmb.local`) and the filler user (`filler@bmb.local`) with `createAdminClient({ apiKey }).auth.signUp({ email, password, autoConfirm: true })` (idempotent: sign-in if it already exists), inserts their `profiles` rows, 25 probe notes with 200–800 char bodies, and 5,000 filler notes so the index matters.
- `insforge.toml` sets `require_email_verification = false` so `signUp` returns a token.

### 5.6 Synthetic-user probe suite (`apps/referee/src/probes.ts`)
Runs every **3 seconds** while a round is active, every **15 seconds** when idle. Each probe records `{ name, ok, ms, error? }`. All use the InsForge SDK as the probe user (`signInWithPassword` once, re-login on 401).

| # | Probe | Pass condition |
|---|---|---|
| P1 | `login` | token obtained |
| P2 | `list_notes` (`select * order by created_at desc limit 20`) | 200, exactly 20 rows, all `owner_id` = probe user, every row has `title` and `body`, `ms < P2_MAX_MS` (400 next to the DB); one retry when only latency failed, because the first request after DDL pays PostgREST's schema-cache reload |
| P3 | `create_note` then `delete_note` | both succeed, created row round-trips `title`/`body` |
| P4 | `rpc note_count` | returns exactly 25 (the probe user's real count; F09's wrong-owner count is huge, not an error) |
| P5 | `invoke summarize` on a known note id, via the SDK as the probe user | 200, `summary` non-empty, `words > 0` |
| P6 | `update_note` on a probe-owned note | 200 and `updated_at` advanced |

Health = all six `ok`. "Green ×3" = three consecutive all-green cycles.

---

## 6. The fault catalog (`packages/shared/src/faults.ts`)

Data shape: see the `Fault` interface in `faults.ts`. Injection code lives in `apps/referee/src/injector/<id>.ts` exporting `{ inject, referenceFix, artifactPresent }`, each returning a promise and each logging the exact CLI command it ran. `artifactPresent()` must be a **state check** (query `pg_policies`, `pg_indexes`, `pg_trigger`, `pg_proc`, `information_schema.columns`, `functions code`), never a probe.

### 6.1 Singles (10 pts each)

| id | name | inject | ground truth | scope | reference fix |
|---|---|---|---|---|---|
| F01 | Lockout | `drop policy notes_select_own; create policy notes_select_own on notes for select to authenticated using (false);` | notes RLS / select policy denies all | P2, P3, P4, P5, P6 (P3: insert…select needs the select policy; P6: update returning) | restore policy |
| F02 | Molasses | `drop index notes_owner_created_idx;` | notes index / missing composite index | P2 | recreate index |
| F03 | Revoked | `revoke select on public.notes from authenticated;` | notes grants / SELECT revoked | P2, P5, P4, P6 | re-grant |
| F04 | Dead Function | `functions deploy summarize --file <broken.ts>` whose handler throws (a module-level throw fails the deployment itself) | summarize edge function / runtime throw on invoke | P5 | redeploy good source |
| F05 | Renamed | `alter table notes rename column body to content;` | notes schema / column `body` renamed | P2 (shape), P3, P5 | rename back |
| F06 | Poison Pill | BEFORE INSERT trigger `notes_block` that raises | notes trigger / insert trigger raises | P3 | drop trigger + function |
| F07 | Vanished RPC | `drop function public.note_count();` | RPC / `note_count` dropped | P4 | recreate + grant |
| F08 | Impossible Rule | `check (length(title) < 1) not valid` constraint (plain ADD CONSTRAINT fails on existing rows) | notes constraint / CHECK makes inserts and updates impossible | P3, P6 | drop constraint |
| F09 | Wrong Owner | `note_count` body uses `owner_id <> auth.uid()` | RPC / logic bug returns others' count | P4 (value wrong, not error) | restore body |
| F10 | Quiet Update | `drop trigger notes_touch on notes;` | trigger / `updated_at` no longer maintained | P6 | recreate trigger |

F09 and F10 are deliberately **silent** faults (no error, wrong behavior).

### 6.2 Decoys (0 pts alone; multiply the attached single's points by 1.5)

Decoys must be **harmless**: no probe may fail because of a decoy. A test injects each decoy alone and asserts probes stay green ×3.

| id | name | inject | why it's a trap |
|---|---|---|---|
| D01 | Log Storm | 500 `audit_log` rows `level='warn'` over the last 10 min; deploy a second edge function `legacy-ping` that logs a warning and returns 200 | noisy logs and a new function in metadata |
| D02 | Bloat | `create table public.scratch_export as select * from notes;` (no index, no RLS) | advisor flags a table without RLS |
| D03 | Slow Neighbor | RPC `public.report_slow()` doing `pg_sleep(1.5)`, called once by the referee | slow query in cloud advisor stats |
| D04 | Extra Policy | `profiles_insert_any` permissive insert policy | advisor security warning |

### 6.3 Combos (30 pts; +50% with a decoy)

| id | composed of | why it's hard |
|---|---|---|
| C01 | F01 + F03 | both present as "can't read notes"; fixing one leaves the other |
| C02 | F04 + F06 | two different components fail |
| C03 | F05 + F07 | schema rename + RPC gone; second failure masked by the first |
| C04 | F02 + F10 | one loud (latency), one silent (stale `updated_at`) |

### 6.4 Catalog invariants (vitest in `packages/shared`)
- ids unique, points > 0 for non-decoys, every `scope` entry is a valid probe id
- every combo's `composedOf` are singles, length exactly 2
- `blurb` contains none of: `policy`, `RLS`, `index`, `grant`, `trigger`, `constraint`, `rename`, `column`, `function`, `rpc` (case-insensitive)

---

## 7. The healer

### 7.1 Healer configs (`configs.ts`)
- **H1 `diagnose-only`**: one call to `diagnose --ai` with the probe failure summary as the question; the healer must produce a fix using only that output plus one `db_query` read. Max 4 tool calls. Cloud-only by construction.
- **H2 `agent+skill`** (DEFAULT for public rounds): full loop, system prompt = `base.md` + the text of the `insforge-debug` skill (SKILL.md and its references), max 25 tool calls, 5-minute wall clock.
- **H3 `agent-noskill`**: same as H2 without the skill text. Batch evaluation only.

### 7.2 Round lifecycle (`runner.ts`)
```
queued → injecting → attacked (probes red confirmed) → healing → [healed | unhealed] → resetting → done
```
- `attacked` requires at least one probe in the fault's `scope` to be red within 30s of injection; otherwise `invalid` and reset.
- TTD = `attacked` → first `submit_diagnosis`. TTM = `attacked` → first moment the oracle says healed.
- Budget exceeded (25 calls or 300s) → `unhealed`, then the referee applies reference fixes.
- After `healed`/`unhealed`: judge, scores, reset, `done`. One round active at a time. FIFO queue.

### 7.3 The constrained tool set (`tools.ts`)

Every tool: zod-validated input, runs a **specific** CLI command via `insforge-cli.ts` with `--json` and `cwd = victim/`, truncates output to 6,000 chars (tail for logs), records call + result to `events`. No tool accepts a raw command string except `db_query`, which is filtered.

Read tools (allowed before and after diagnosis):
| tool | maps to |
|---|---|
| `get_metadata` | `metadata --json` |
| `diagnose(kind: 'advisor'\|'db'\|'metrics'\|'logs')` | `diagnose <kind> --json` |
| `diagnose_ai(question)` | `diagnose --ai "<question>" --json` |
| `get_logs(source, limit≤200)` | `logs <source> --limit N --json`; `source ∈ {insforge.logs, postgREST.logs, postgres.logs, function.logs, function-deploy.logs}` |
| `db_policies` / `db_indexes` / `db_triggers` / `db_functions` / `db_tables` | `db <x> --json` |
| `list_functions` / `get_function_source(slug)` | `functions list --json` / `functions code <slug> --json` |
| `db_query(sql)` READ MODE | `db query "<sql>" --json` — only if sql matches `^\s*(select\|explain\|with)\b` and contains no `;` |
| `probe_status` | latest probe results `{name, ok, ms, error}` — the healer's only referee-provided signal; contains no fault ids |

Gate tool: `submit_diagnosis({ component, mechanism, affected: string[], confidence: 0–1, reasoning })` — stored verbatim; unlocks write tools; may be revised (judge uses the LAST, TTD the FIRST).

Write tools (locked until `submit_diagnosis`):
| tool | maps to | allow-list |
|---|---|---|
| `db_execute(sql)` | `db query "<sql>" --json` | first keyword ∈ `{create, alter, drop, grant, revoke, comment}`; single statement; objects in `public`; **deny** `audit_log` deletion, `profiles` drop, `truncate`, `pg_terminate`, `pg_sleep`, any schema other than `public`/`pg_catalog` |
| `deploy_function(slug, source)` | writes `source` to a temp file, runs `functions deploy <slug> --file <tmp> --json` | `slug ∈ {summarize, legacy-ping}` |
| `run_migration_sql(sql)` | same as `db_execute` but logged as a migration | same allow-list |

Denied entirely: shell, filesystem, `db import/export`, `local`, `branch`, `config apply`, `compute`, secrets, auth admin, anything on `bmb-control`.

### 7.4 System prompt `base.md` (under 600 words). Must include:
- Role: on-call engineer for an InsForge backend you did not build.
- The probe suite is your alert. Start from `probe_status`.
- **Generate at least two competing hypotheses before submitting a diagnosis.**
- Verify any `diagnose_ai` suggestion against a primitive before acting on it.
- After every fix, call `probe_status`. Do not declare done while any probe is red. There may be more than one fault.
- One tool call per step, short reasoning, no prose walls. You are not told how many faults there are.

### 7.5 Healer step recording
Every step writes an `events` row: `healer_thought`, `tool_call`, `tool_result` (truncated), `diagnosis`, `fix_applied`, `verify`, `healed`, `gave_up`, with `tokens_in`/`tokens_out` from the API response.

---

## 8. Oracle and judge

### 8.1 Mitigation oracle (`oracle.ts`)
`healed(round) := probesGreenConsecutive >= 3 && faults.every(f => !artifactPresent(f))`
- Checked after every healer tool call and on a 3s timer.
- Probes green but artifact still present (e.g. a *second* permissive policy instead of fixing the first) → `healed=false, reason='artifact_present'`, round keeps running. Documented in `docs/SCORING.md` as the reward-hacking guard.

### 8.2 Diagnosis judge (`judge.ts`)
Input: ground truth for every fault in the round + the healer's last `submit_diagnosis`. Never the tool history.

Nine yes/no questions, three dimensions, pass threshold **7/9** and no dimension may score 0:

Localization — 1. same component(s)? 2. origin vs downstream symptom? 3. avoids naming a healthy component?
Characterization — 4. same mechanism? 5. concrete detail (policy/index/column/trigger/constraint/function name)? 6. avoids an unrelated fault type?
Scope — 7. avoids blaming decoys? 8. combos: names **both** faults (singles auto-yes)? 9. impact consistent with affected probes?

Strict JSON `{ answers: boolean[9], evidence: string[9], score, pass, dims: {loc, char, scope} }`. Temperature 0. Stored on the round.

### 8.3 Scoring (`packages/shared/src/scoring.ts`, pure)
- Attacker points: `points × (decoy ? 1.5 : 1) × (healed ? 0 : 1) + (healed && !judge.pass ? 0.5 × points : 0)`.
- Healer aggregates (last 200 done rounds, per config): `heal_rate`, `median_ttd_ms`, `median_ttm_ms`, `diag_pass_rate`, `p_heal_given_diag`, `p_heal_given_no_diag` (**lucky-fix rate**), `mean_tool_calls`, `mean_tokens`, plus `diag_pass_rate` by fault id.

---

## 9. Web app

### 9.1 Design tokens — see `apps/web/styles/globals.css`. Monospace for the heal log, status, numbers. Sans for labels. No gradients, no glassmorphism, radius ≤ 6px. Gold only for the active state and the wall of fame.

### 9.2 Layout: single page, three regions (attack panel | heal log, scoreboard + wall of fame below), stacks on mobile. StatusPill: HEALTHY | UNDER ATTACK | HEALING.

### 9.3 Behavior
- `AttackPanel`: cards from the catalog (`id`, `name`, `blurb`, `points`, tier). Decoy dropdown per single. Combos tab. Disabled during cooldown or while the session already has a queued round.
- `POST /api/attack` `{ faultId, decoyId?, handle? }` → validate against catalog, then call the control project's `enqueue_round` RPC (security definer) with keyed hashes of the session cookie and IP. The RPC enforces **1 attack per session or IP per 3 minutes**, one queued round per session, and the queue cap, and returns `{ roundId, position }`. Anon has no insert privilege on `rounds`.
- `HealLog`: subscribes to the control project's realtime channel (`realtime.channels` pattern `round:%`; a trigger on `events` calls `realtime.publish`). Fallback: poll `/api/events?since=` every 2s. Active round live; previous round collapses into a replay accordion. Tool results collapsible; thoughts dimmed; diagnosis gold; `healed` green; `gave_up` red.
- `Scoreboard`: `GET /api/scoreboard` (cached 10s) with a "by fault" table.
- `WallOfFame`: last 20 unhealed rounds.
- `HowScoringWorks`: modal with the 9 questions and the formulas.
- Idle mode: no round for > 60s → the referee runs a **self-play round** (random single, H2) every 10 minutes, `attacker='self-play'`, excluded from the Wall of Fame.

### 9.4 Anti-abuse
- Catalog ids only; anything else 400. Handle `^[a-zA-Z0-9_]{3,16}$`, lowercased, small denylist.
- Global: max 1 active + 10 queued rounds; otherwise 429.
- No auth, no email, no analytics beyond a page-view counter.

---

## 10. Control project schema (`control/migrations/`)

```sql
create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  attacker_session text not null,          -- hashed cookie; 'self-play' for idle rounds
  attacker_handle text,
  fault_ids text[] not null,
  combo_id text,
  healer_config text not null,             -- H1|H2|H3
  status text not null default 'queued',
  attacked_at timestamptz, diagnosed_at timestamptz, healed_at timestamptz, ended_at timestamptz,
  diagnosis jsonb, judge jsonb,
  healed boolean, unhealed_reason text,     -- budget_calls|budget_time|artifact_present|error
  tool_calls int not null default 0, tokens_in int not null default 0, tokens_out int not null default 0,
  attacker_points numeric not null default 0
);

create table public.events (
  id bigserial primary key,
  round_id uuid not null references public.rounds(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  payload jsonb not null
);
create index events_round_at_idx on public.events(round_id, at);
-- RLS: anon may SELECT events and the view rounds_public (omits attacker_session); only project_admin writes.
-- Realtime: insert into realtime.channels ('round:%'); AFTER INSERT trigger on events → realtime.publish('round:'||round_id, kind, payload).
```

`0002_views.sql`: `healer_stats`, `fault_stats`, `wall_of_fame`.

---

## 11. Build phases with acceptance gates

**Phase 0 — Scaffold.** pnpm workspaces, biome, tsconfig, package.json files, `.env.example`s, `docs/INSFORGE_NOTES.md`. Gate: `pnpm -r typecheck` and `pnpm -r lint` pass; notes cover every ⚠ VERIFY.

**Phase 1 — Victim app + probes.** Migrations applied to `bmb-victim` with `db migrations up --all`, `insforge.toml` applied, `summarize` deployed, users + seed created by the referee's seed script. Gate: `pnpm --filter @bmb/referee probes` prints 6/6 green three times in a row with per-probe ms.

**Phase 2 — Injector + reference fixes.** One file per fault and decoy; `test/faults.test.ts` proves inject → red (scope only) → artifactPresent → referenceFix → green ×3 → !artifactPresent; decoys alone stay green; combos leave both artifacts and fixing one leaves probes red. Gate: the test file passes.

**Phase 3 — Healer loop, one fault.** `insforge-cli.ts`, `tools.ts`, `runner.ts`, `base.md`, H2. Gate: a recorded F01 run (probe_status → ≥2 hypotheses → submit_diagnosis → db_execute → green → healed); a negative test where a fake model response calls `db_execute("truncate notes")` and is denied; the ground-truth isolation test passes.

**Phase 4 — Oracle, judge, scoring.** Gate: F01, F09, C01 each once with H2, judge JSON shown, artifact guard shown firing once.

**Phase 5 — Control project + realtime + web.** Gate: click Lockout in the browser → heal log streams → scoreboard updates without reload.

**Phase 6 — Decoys, combos, queue, rate limits, self-play.** Gate: F02+D01 shows the decoy inspected; C01 shows both artifacts checked; second session gets queue position 1; rate limit 429 with cooldown remaining.

**Phase 7 — Batch evaluation.** `pnpm --filter @bmb/referee eval --config H1,H2,H3 --faults all --repeats 3` → `docs/EVAL_<date>.md`.

**Phase 8 — Deploy.** `bmb-control` created and migrated; web via `deployments deploy`; referee via `compute deploy`; on boot it runs reset + a probe check. Gate: public URL; one full round from a phone.

**Phase 9 — Write-up.** Section 12.

---

## 12. README as a case study, and the misses log

README structure: (1) what it is, live link, 15-second GIF; (2) why it exists — every AI-SRE benchmark lives on Kubernetes, this is the same idea on the stack vibe-coded apps run on, with citations; (3) results table from `docs/EVAL_<date>.md`, H2 vs H3 delta called out; (4) "Where it breaks" → `docs/MISSES.md` (fault id, config, what `diagnose --ai` said, what was actually wrong, what fixed it, upstream link), neutral tone; (5) architecture (mermaid) and trust boundaries; (6) run locally in 5 commands; (7) how to add a fault.

`docs/MISSES.md` is appended automatically by the referee whenever `judge.pass === false` or `healed === false`.

---

## 13. Things to explicitly NOT build (v1)
No free-form SQL from attackers. No accounts, OAuth, email. No multi-tenant arenas. No LLM-generated faults. No charting library. No streaming of raw chain-of-thought; only the short per-step "thought" text.

---

## 14. Definition of done
- All nine phase gates shown with real output and committed.
- `pnpm -r test`, `pnpm -r typecheck`, `pnpm -r lint` green.
- Public URL up for 48 hours with self-play running and no crash.
- `docs/EVAL_<date>.md`, `docs/MISSES.md`, `README.md` complete.
- At least one entry in `docs/MISSES.md` with an upstream issue filed against `insforge/agent-skills` (Abhijeet files it; the body is drafted here with the exact repro).
