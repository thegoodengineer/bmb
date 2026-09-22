import 'server-only';

/**
 * The referee only polls the control project, so nothing else ever sends it traffic. If the
 * platform stopped its machine (a crash loop, host maintenance), a request through the
 * platform proxy starts it again. Every accepted attack pings it, after the response is sent.
 */
export async function wakeReferee(): Promise<void> {
  const base = process.env.REFEREE_URL;
  if (!base) return;
  try {
    await fetch(new URL('/health', base), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  } catch {
    // Best effort. A cold start can outlast the timeout; the proxy has started it by then.
  }
}
