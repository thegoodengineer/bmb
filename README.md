# Break My Backend

A public, live, adversarial mini-benchmark for agent-native backends, built on [InsForge](https://insforge.dev). Strangers pick a fault from a menu and it is injected into a real InsForge app: a policy flipped, an index dropped, a grant revoked, a function redeployed broken, a column renamed. An AI healer with a constrained toolset over the InsForge CLI has to diagnose and repair it, live. Because the attacker chose the fault, the game knows the ground truth, so it grades the **diagnosis** and the **fix** separately, and reports how often the healer fixes things it misdiagnosed.

Live: https://zfy5cb5v.insforge.site · Repo: https://github.com/thegoodengineer/bmb

## Why this exists

Every AI-SRE benchmark lives on Kubernetes. The apps people actually vibe-code run on Postgres with row-level security, an RPC or two, and an edge function. This is the same idea on that stack, small enough to read in an afternoon and honest enough to publish its misses.

The mechanics are borrowed, with credit: faults-not-symptoms, decoys, compound failures, a state-based mitigation oracle, a checklist LLM judge and reward-hacking protection come from **SREGym** (arXiv 2605.07161); the precision-at-full-recall strictness of the judge comes from **ITBench-AA** (Artificial Analysis / IBM).

## Results

The batch evaluation (`pnpm --filter @bmb/referee eval`, written to `docs/EVAL_<date>.md`, with the H2 versus H3 delta that measures what the `insforge-debug` skill is worth) has not run yet. It needs about 160 rounds, and the free model tier the live site runs on allows roughly a dozen per day. Until it runs, this is the complete record of scored public rounds. All of them used configuration H2 with the compact skill, on Groq's free tier, with `gpt-oss-120b` falling back to `gpt-oss-20b` when its quota ran out.

| Round | Fault | Started by | Healed | Judge | Time to diagnosis | Time to mitigate | Tool calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bea3bddc` | F01 Lockout | visitor | yes | 9/9 | 96 s | 153 s | 8 |
| `2cde6ec2` | F02 Molasses + D01 Log Storm decoy | visitor | yes | 9/9 | 167 s | 175 s | 7 |
| `c537222f` | F07 Vanished RPC | visitor | no, stopped | 9/9 | 59 s | – | 9 |
| `c3bc6582` | F08 Impossible Rule | self-play | yes¹ | 9/9 | 25 s | 111 s | 7 |
| `499c6a31` | F06 Poison Pill | self-play | no, out of time | 0/9 | – | – | 17 |
| `e8594c4e` | F07 Vanished RPC | visitor | yes | 9/9 | 218 s | 349 s | 9 |

Four of six rounds were healed and five of six diagnoses passed. There were no lucky fixes (healed with a failed diagnosis). The median time to mitigate was 164 s. Rounds that ended on a provider failure or a referee error are recorded as invalid and excluded, as [`docs/SCORING.md`](docs/SCORING.md) specifies.

¹ Recorded as unhealed when it ran. The artifact check then treated any CHECK constraint as the fault, including the healer's valid replacement. The check was fixed and the round reclassified; [`docs/MISSES.md`](docs/MISSES.md) has the details.

## Where it breaks

See [`docs/MISSES.md`](docs/MISSES.md). Each entry records what the platform's `diagnose --ai` said, what the healer diagnosed, what was actually wrong, and what fixed it. Neutral and reproducible.

## How it works

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the diagram and the data flow. The short version:

- **Victim** (`bmb-victim`): a boring notes app. `notes`, `profiles`, `audit_log`, RLS with `auth.uid()`, one composite index, one trigger, one RPC, one edge function. 400k filler rows so a dropped index is measurable.
- **Referee** (`apps/referee`): the only trusted process. Injects faults, runs six synthetic-user probes every 3 s, decides healing from backend state (`green ×3 AND artifact gone`), runs the judge, scores, resets.
- **Healer**: an LLM inside the referee that receives only probe results and 17 tools, each pinned to one `npx @insforge/cli … --json` command in the victim's directory. It must `submit_diagnosis` before any write tool unlocks. It never sees fault ids, the catalog, or the control project; a test proves it ([`apps/referee/test/isolation.test.ts`](apps/referee/test/isolation.test.ts)).
- **Control** (`bmb-control`): rounds and events. The web app holds only its anon key; enqueueing goes through a `security definer` RPC that enforces cooldowns and caps.
- **Web** (`apps/web`): one page, realtime heal log with polling fallback, scoreboard, wall of fame.

Scoring, the nine judge questions and the reward-hacking guard are in [`docs/SCORING.md`](docs/SCORING.md). The fault menu and its ground truth are generated into [`docs/FAULT_CATALOG.md`](docs/FAULT_CATALOG.md). Everything that had to be checked against the platform, with evidence, is in [`docs/INSFORGE_NOTES.md`](docs/INSFORGE_NOTES.md).

## Run it locally in five commands

Prerequisites: Node 20+, pnpm 12, an InsForge account (`npx @insforge/cli login`), and a model key: an Anthropic key (default), or a free Groq/OpenRouter key with `LLM_PROVIDER=groq|openrouter` (see `apps/referee/.env.example`; free tiers cap tokens per minute, so rounds are slower and the H2 prompt drops the skill's reference files).

```bash
pnpm install && pnpm -r build
cd victim && npx @insforge/cli create --json --name bmb-victim --org-id <org> --region us-east --template empty && npx @insforge/cli config apply --auto-approve --json && npx @insforge/cli db migrations up --all --json && npx @insforge/cli functions deploy summarize --file functions/summarize/index.ts --json && cd ..
cd control && npx @insforge/cli create --json --name bmb-control --org-id <org> --region us-east --template empty && npx @insforge/cli db migrations up --all --json && cd ..
cp apps/referee/.env.example apps/referee/.env && cp apps/web/.env.example apps/web/.env.local   # fill the keys: victim/.insforge/project.json, `secrets get ANON_KEY`
pnpm --filter @bmb/referee seed && pnpm --filter @bmb/referee dev & pnpm --filter @bmb/web dev
```

Useful commands:

| command | what |
| --- | --- |
| `pnpm --filter @bmb/referee probes --times 4` | run the probe suite; passes on 3 consecutive green cycles |
| `pnpm --filter @bmb/referee test:faults` | inject → red → artifact → fix → green ×3 for every fault, decoy and combo (~20 min against the cloud) |
| `pnpm --filter @bmb/referee test:unit` | ground-truth isolation, write-gate denial, judge scoring |
| `pnpm --filter @bmb/referee heal --fault F01 --config H2` | one live round with the transcript printed |
| `pnpm --filter @bmb/referee eval --config H1,H2,H3 --faults all --repeats 3` | the batch evaluation → `docs/EVAL_<date>.md` |
| `pnpm --filter @bmb/referee reset` | reference fixes + decoy cleanup + seed + artifact check |
| `pnpm docs:catalog` | regenerate `docs/FAULT_CATALOG.md` |
| `pnpm web:package`, then `cd control && npx @insforge/cli deployments deploy <printed dir> --json` | deploy the web app through InsForge to Vercel |

## How to add a fault

1. Add an entry to `packages/shared/src/faults.ts` (id, tier, player-facing name and blurb, points, ground truth with the probes it affects). The invariants test bans mechanism words in the blurb.
2. Add an injector in `apps/referee/src/injector/` exporting `inject`, `referenceFix` and `artifactPresent`. The artifact check must read catalog state, never a probe, and should accept any correct fix, not only the reference one.
3. Register it in `apps/referee/src/injector/index.ts` and run `pnpm --filter @bmb/referee test:faults -t <id>`. The test tells you the real scope (which probes go red); put that in the catalog.
4. `pnpm docs:catalog`.

## Status

Phases 0–6 and 8 are built and verified against the cloud projects; each gate's output is in the commit history. The site is live. The referee runs as an always-on InsForge compute service (`bmb-referee`, iad). The healer and judge run on Groq's free tier, falling back across `gpt-oss-120b`, `gpt-oss-20b` and `qwen3.8-27b` as each model's daily quota runs out. When all three are spent, a round ends as "model provider unavailable" and is not scored.

Still open:

- **Phase 7 batch evaluation.** It waits on a paid model key or several days of free quota.
- **README extras.** The 15-second GIF is missing, and the results table above will be replaced by the evaluation's.
- **A 48-hour unattended run.** The referee recovers from a broken victim by itself, and the web app wakes it if the platform stops its machine ([`docs/INSFORGE_NOTES.md`](docs/INSFORGE_NOTES.md) §M).
