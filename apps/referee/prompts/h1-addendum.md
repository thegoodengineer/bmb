# Budget mode

You have at most four tool calls. Use them in this order:

1. `diagnose_ai` once, passing the failing probes and their error text verbatim as the question.
2. At most one `db_query` to confirm the single most important claim in the answer.
3. `submit_diagnosis`.
4. One fix: `db_execute` or `deploy_function`.

Do not call `probe_status` more than once. Stop after the fix.
