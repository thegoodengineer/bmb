import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isValidAttack } from '@/lib/catalog';
import { controlClient } from '@/lib/control';
import { getOrCreateSessionId, ipHash, sessionHash } from '@/lib/session';

export const runtime = 'nodejs';

const bodySchema = z.object({
  faultId: z.string().regex(/^[FC]\d\d$/),
  decoyId: z
    .string()
    .regex(/^D\d\d$/)
    .optional(),
  handle: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{3,16}$/)
    .optional(),
});

const DENYLIST = ['admin', 'insforge', 'nigger', 'faggot', 'hitler', 'rape'];

/**
 * POST /api/attack { faultId, decoyId?, handle? } → { roundId, position }
 * Validation here (catalog ids, handle shape/denylist); cooldown, queue caps and duplicate
 * queued rounds are enforced by the control project's `enqueue_round` RPC.
 */
export async function POST(req: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'invalid attack' }, { status: 400 });
  const { faultId, decoyId } = parsed.data;
  if (!isValidAttack(faultId, decoyId)) {
    return NextResponse.json({ error: 'unknown fault' }, { status: 400 });
  }
  const handle = parsed.data.handle?.toLowerCase();
  if (handle && DENYLIST.some((w) => handle.includes(w))) {
    return NextResponse.json({ error: 'pick another handle' }, { status: 400 });
  }

  const session = sessionHash(await getOrCreateSessionId());
  const ip = await ipHash();
  const faultIds = decoyId ? [faultId, decoyId] : [faultId];

  const { data, error } = await controlClient().database.rpc('enqueue_round', {
    p_fault_ids: faultIds,
    p_handle: handle ?? null,
    p_session: session,
    p_ip: ip,
  });

  if (error) {
    const msg = String(error.message ?? '');
    if (msg.startsWith('COOLDOWN:')) {
      const wait = Number(msg.split(':')[1]) || 180;
      return NextResponse.json(
        { error: 'cooldown', retryAfterSeconds: wait },
        { status: 429, headers: { 'Retry-After': String(wait) } },
      );
    }
    if (msg.includes('ALREADY_QUEUED'))
      return NextResponse.json({ error: 'you already have a round queued' }, { status: 429 });
    if (msg.includes('QUEUE_FULL'))
      return NextResponse.json(
        { error: 'queue is full, try again in a few minutes' },
        { status: 429 },
      );
    if (msg.includes('BAD_'))
      return NextResponse.json({ error: 'invalid attack' }, { status: 400 });
    return NextResponse.json({ error: 'could not enqueue' }, { status: 502 });
  }
  const out = data as { roundId: string; position: number };
  return NextResponse.json({ roundId: out.roundId, position: out.position });
}
