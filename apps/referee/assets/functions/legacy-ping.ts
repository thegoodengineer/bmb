// Decoy edge function: logs a warning on every call and returns 200. It is noise in
// `functions list`, `metadata` and `function.logs`, and affects no probe.
export default async function (_req: Request): Promise<Response> {
  console.warn('legacy-ping: deprecated endpoint hit, clients should migrate to /v2');
  return new Response(JSON.stringify({ ok: true, deprecated: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
