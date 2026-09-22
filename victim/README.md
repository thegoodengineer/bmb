# victim — the `bmb-victim` InsForge project

The deliberately boring notes app that gets broken. Everything the healer is allowed to touch lives in this project; the referee holds its admin key, the healer's tools run `npx @insforge/cli` from this directory.

- Cloud project: `bmb-victim`, region `us-east`, API base `https://y2z8xzxf.us-east.insforge.app`
- Link state lives in `.insforge/project.json` (gitignored). Re-link with `npx @insforge/cli link --project-id ec1dfccd-4a93-43a6-830c-84071cb0188b`.
- `AGENTS.md` and `.env.local` were written by `npx @insforge/cli create`; the agent skills it installs are gitignored and reinstalled by `link`.

## Layout

```
migrations/            schema, policies, functions, seed — applied with `db migrations up --all`
functions/summarize/   the ONE edge function (good version), deployed with `functions deploy summarize --file …`
```

## Reset between rounds

`branch reset` is cloud-only and takes minutes, and `db export` omits indexes and grants (see `docs/INSFORGE_NOTES.md`). The referee therefore resets by applying every fault's reference fix and re-running the idempotent seed. Phase 1 fills in the commands.
