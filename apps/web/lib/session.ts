import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';

/**
 * Anonymous attacker session (SPEC.md §4): a random id in a signed, httpOnly cookie. What
 * the control project stores is a keyed hash of the id, never the id itself, so a leaked
 * database row cannot be replayed as a cookie.
 */
const COOKIE = 'bmb_session';

function secret(): string {
  const s = process.env.ATTACKER_SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('ATTACKER_SESSION_SECRET is not set');
  return s;
}

function sign(id: string): string {
  return createHmac('sha256', secret()).update(id).digest('base64url');
}

function hash(value: string, scope: string): string {
  return createHmac('sha256', secret()).update(`${scope}:${value}`).digest('base64url');
}

/** Returns the session id, creating the cookie when missing or tampered. */
export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw) {
    const [id, sig] = raw.split('.');
    if (id && sig) {
      const expected = sign(id);
      if (
        sig.length === expected.length &&
        timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      ) {
        return id;
      }
    }
  }
  const id = randomBytes(18).toString('base64url');
  jar.set(COOKIE, `${id}.${sign(id)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

export function sessionHash(id: string): string {
  return hash(id, 'session');
}

export async function ipHash(): Promise<string> {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  return hash(ip, 'ip');
}
