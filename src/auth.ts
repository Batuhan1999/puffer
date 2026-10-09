// The user's account on the relay: Better Auth's Expo client, which keeps its session cookie in the Keychain
// (expo-secure-store). The session token goes to native (bridge.setRelaySession), which sends it once to register this
// iPhone; syncing then uses the device key as before.
import { expoClient } from '@better-auth/expo/client';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';
import { useEffect } from 'react';

import { bridge } from '../modules/puffer-native/src';
import { errorText } from './store';

/** The relay accounts live on: the one a new install registers with, RelayClient.defaultRelay in Relay.swift. */
export const ACCOUNT_RELAY = 'https://puffer.fly.dev';

export const authClient = createAuthClient({
  baseURL: ACCOUNT_RELAY,
  plugins: [expoClient({ scheme: 'puffer', storagePrefix: 'puffer', storage: SecureStore })],
});

type AuthResult = { data: { token: string | null } | null; error: { message?: string; statusText: string } | null };

/** Better Auth answers `{ error }` instead of throwing; this throws it, for alertError, and hands the token to native. */
async function handOver({ data, error }: AuthResult): Promise<void> {
  if (error) throw new Error(error.message ?? error.statusText);
  if (data?.token) await bridge.setRelaySession(data.token);
}

export async function signIn(email: string, password: string): Promise<void> {
  await handOver(await authClient.signIn.email({ email, password }));
}

/** Without email verification the relay signs the new account in at once. */
export async function signUp(name: string, email: string, password: string): Promise<void> {
  await handOver(await authClient.signUp.email({ name, email, password }));
}

/** Native forgets the token first, so a failed sign-out request still leaves this iPhone signed out. */
export async function signOut(): Promise<void> {
  await bridge.setRelaySession(null);
  await authClient.signOut();
}

/** Hands the session token to native whenever the client has one, after a relaunch too. Signing out clears it. */
export function useRelaySessionHandoff(): void {
  const token = authClient.useSession().data?.session.token ?? null;
  useEffect(() => {
    if (token) bridge.setRelaySession(token).catch((e) => console.warn('relay session handoff failed', errorText(e)));
  }, [token]);
}
