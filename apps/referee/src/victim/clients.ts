import { createAdminClient, createClient, type InsForgeClient } from '@insforge/sdk';
import type { Env } from '../env.js';

/**
 * SDK clients for the victim project.
 *
 *  - adminClient: the project API key (full access). Referee-only, used for seeding.
 *  - anonClient: the anon key, used to sign users in.
 *  - loginAs: signs in with email/password and returns a client bound to that user's JWT.
 *    The static-token client does not refresh; callers re-login when they see a 401.
 */

export function adminClient(env: Env): InsForgeClient {
  return createAdminClient({ baseUrl: env.VICTIM_URL, apiKey: env.VICTIM_API_KEY });
}

export function anonClient(env: Env): InsForgeClient {
  return createClient({ baseUrl: env.VICTIM_URL, anonKey: env.VICTIM_ANON_KEY });
}

export interface UserSession {
  client: InsForgeClient;
  userId: string;
  accessToken: string;
}

export async function loginAs(env: Env, email: string, password: string): Promise<UserSession> {
  const { data, error } = await anonClient(env).auth.signInWithPassword({ email, password });
  if (error || !data?.accessToken || !data.user?.id) {
    throw new Error(`login failed for ${email}: ${error?.message ?? 'no session returned'}`);
  }
  return {
    client: createClient({ baseUrl: env.VICTIM_URL, accessToken: data.accessToken }),
    userId: data.user.id,
    accessToken: data.accessToken,
  };
}
