# control — the `bmb-control` InsForge project

Rounds, events and scores. The web app reads it with the anon key over PostgREST and realtime; the referee writes with the service key. The healer has no credentials for this project and no tool that can reach it.

Created in Phase 5. `migrations/` holds the schema (`rounds`, `events`), the public views, and the realtime channel pattern + publish trigger.
