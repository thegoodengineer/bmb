# control — the `bmb-control` InsForge project

Rounds, events and scores. The web app reads it with the anon key over PostgREST and realtime and enqueues rounds through one RPC; the referee writes with the project API key. The healer has no credentials for this project and no tool that can reach it.

- Cloud project: `bmb-control`, region `us-east`, API base `https://zfy5cb5v.us-east.insforge.app`
- Link state in `.insforge/project.json` (gitignored). Re-link with `npx @insforge/cli link --project-id 13d49489-3b66-467e-98de-f92cb8ab2e23`.

## Migrations

| file | what |
| --- | --- |
| `20260922120000_rounds-events.sql` | `rounds`, `events`, RLS, anon column grants (never `attacker_session` / `attacker_ip`), realtime channel patterns `round:%` and `rounds:all`, publish triggers |
| `20260922120100_views.sql` | `rounds_public`, `queue_public`, `healer_stats` (security_invoker), `wall_of_fame()` (security definer, excludes self-play) |
| `20260922120200_enqueue-rpc.sql` | `enqueue_round(fault_ids, handle, session, ip)`: validation, cooldown, one queued round per session, queue cap 10; direct anon inserts removed |
| `20260922120300_ip-limit.sql` | cooldown is 3 minutes per session; the IP hash only caps cookie-clearing at 3 rounds per 10 minutes |

Bring-up:

```bash
cd control
npx @insforge/cli db migrations up --all --json
```

Verified after apply (2026-09-22): views `queue_public, healer_stats, rounds_public`; functions `publish_event, publish_round, wall_of_fame, enqueue_round`; channels `round:%, rounds:all`; policies `events_read_all, rounds_read_all`; triggers `events_publish, rounds_publish`. As anon: `enqueue_round` returns `{roundId, position}`, a second call within 3 minutes returns `COOLDOWN:<seconds>`, a bad id returns `BAD_FAULTS`, a direct insert and a read of `attacker_session` both return `42501 permission denied`.

## Realtime

Each `events` insert is published on `round:<round_id>` with the event kind as the event name; each `rounds` insert or update is published on `rounds:all` as `round`. The web app subscribes with the anon key and falls back to 2-second polling of `/api/rounds` and `/api/events` when the socket is unavailable.
