# victim — the `bmb-victim` InsForge project

The deliberately boring notes app that gets broken. Everything the healer is allowed to touch lives in this project; the referee holds its admin key, and every healer tool is a specific `npx @insforge/cli … --json` invocation run from this directory.

- Cloud project: `bmb-victim`, region `us-east`, instance `nano`, API base `https://y2z8xzxf.us-east.insforge.app`
- Link state lives in `.insforge/project.json` (gitignored, contains the admin key). Re-link with `npx @insforge/cli link --project-id ec1dfccd-4a93-43a6-830c-84071cb0188b`.
- `AGENTS.md` and `.env.local` were written by `npx @insforge/cli create`; the agent skills it installs are gitignored and reinstalled by `link`.

## Layout

```
insforge.toml            project config (only auth flags matter here: email verification off)
migrations/              20260922100000_schema.sql · …100100_policies.sql · …100200_functions.sql
functions/summarize/     the ONE edge function (good version), ESM for Deno Subhosting
```

## Bring-up from scratch (what Phase 1 did)

```bash
cd victim
npx @insforge/cli config apply --auto-approve --json                       # require_email_verification=false
npx @insforge/cli db migrations up --all --json                            # schema, RLS + grants, RPC + trigger
npx @insforge/cli functions deploy summarize --file functions/summarize/index.ts --json
cd ../apps/referee && cp .env.example .env                                  # fill VICTIM_URL / keys / passwords
pnpm --filter @bmb/shared build
pnpm --filter @bmb/referee seed                                             # users, profiles, 25 + 200k notes (idempotent)
pnpm --filter @bmb/referee probes --times 3                                 # the Phase 1 gate
```

Notes:

- `migrations/` must contain only `<YYYYMMDDHHMMSS>_<kebab>.sql` files; a stray `.gitkeep` makes `up --all` refuse.
- The function deploy occasionally returns `"deployment": {"status": "failed"}` with a 502 HTML page from the build service; re-running the same command succeeds. `functions list --json` shows `deploymentUrl` once it is live.
- The seed creates users through the admin SDK (`signUp` with `autoConfirm: true`), never via SQL on `auth.users`.
- Filler volume is `FILLER_NOTES` (default 200,000, ~50 MB). The spec said 5,000, which is far too small for a dropped index to be observable; Phase 2 sizes this against a measured `explain analyze`.

## Reset between rounds

`branch reset` is cloud-only and takes minutes, and `db export`/`db import` are not faithful (see `docs/INSFORGE_NOTES.md` §F). The referee resets by applying every fault's reference fix and re-running the idempotent seed, then re-checking every `artifactPresent()`.
