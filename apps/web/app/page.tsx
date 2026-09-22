import { Arena } from '@/components/Arena';
import { publicCatalog } from '@/lib/catalog';
import { fetchEvents, fetchRecentRounds, type PublicEvent, type PublicRound } from '@/lib/control';

export const dynamic = 'force-dynamic';

const ACTIVE = new Set(['injecting', 'attacked', 'healing', 'healed', 'unhealed', 'resetting']);

export default async function Page() {
  let rounds: PublicRound[] = [];
  let events: PublicEvent[] = [];
  try {
    rounds = await fetchRecentRounds(30);
    const shown =
      rounds.find((r) => ACTIVE.has(r.status)) ?? rounds.find((r) => r.status === 'done');
    if (shown) events = await fetchEvents(shown.id);
  } catch {
    // The client falls back to polling; an unreachable control project renders an empty arena.
  }
  return <Arena catalog={publicCatalog()} initialRounds={rounds} initialEvents={events} />;
}
