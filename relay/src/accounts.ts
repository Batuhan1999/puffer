// User accounts: Better Auth (better-auth.com) at /api/auth, on a SQLite file next to the registry state. A user signs
// in with email and password (or with Apple when configured) and gets a session token, which the app sends as
// `Authorization: Bearer <token>` (bearer plugin) to register a device. Admins (admin plugin, role "admin") manage users
// at /api/auth/admin/* and see the operator's /v1/admin routes. Deleting a user, by an admin or by the user, deletes
// their devices through `onUserDeleted`. Agents never see any of this: their ak_ keys and OAuth (oauth.ts) are separate.
// Single writer of auth.db and auth-secret.

import { randomBytes, sign } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { admin } from 'better-auth/plugins/admin';
import { bearer } from 'better-auth/plugins/bearer';

/** Where Better Auth is mounted. The app's client uses the default path. */
export const AUTH_BASE_PATH = '/api/auth';
/** The app's URL scheme (app.json "scheme"). Trusted as an origin so the Expo client may call the auth routes. */
const APP_ORIGIN = 'puffer://';
/** Set by the relay from the caller's address (Fly-Client-IP or the socket), never taken from the client. */
export const CLIENT_IP_HEADER = 'x-puffer-client-ip';
const MIN_SECRET_LENGTH = 32;

export type AccountsOptions = {
  /** The registry state directory: auth.db and, outside production, auth-secret live here. */
  stateDir: string;
  /** The relay's public origin; Better Auth answers at <baseURL>/api/auth. */
  baseURL: string;
  /** NODE_ENV=production: BETTER_AUTH_SECRET is required, and Better Auth rate-limits sign-in. */
  production: boolean;
  env: NodeJS.ProcessEnv;
  /** A user was deleted (admin remove-user or delete-user): delete their devices. */
  onUserDeleted: (userId: string) => void;
};

export type SignedIn = { userId: string; email: string; admin: boolean };

export type Accounts = {
  /** Serves /api/auth/*. */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** The user a request's session (Bearer token or cookie) names; null without a valid session or for a banned user. */
  session: (headers: IncomingHttpHeaders) => Promise<SignedIn | null>;
  /** Emails by user id, for the operator's device listing. */
  emails: (userIds: readonly string[]) => Map<string, string>;
  userCount: () => number;
};

/** BETTER_AUTH_SECRET, or outside production one minted once into <stateDir>/auth-secret (0600). */
function secretFor(options: AccountsOptions): string {
  const configured = options.env.BETTER_AUTH_SECRET ?? '';
  if (configured !== '') {
    if (configured.length < MIN_SECRET_LENGTH) throw new Error(`BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    return configured;
  }
  if (options.production) throw new Error('BETTER_AUTH_SECRET is required in production (NODE_ENV=production): set it to 32+ random characters');
  const path = join(options.stateDir, 'auth-secret');
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const minted = randomBytes(32).toString('base64url');
  writeFileSync(path, `${minted}\n`, { mode: 0o600 });
  return minted;
}

/** Comma-separated env list, trimmed, empty entries dropped. */
function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Sign in with Apple when APPLE_CLIENT_ID (the Services ID), APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (the .p8
 * PEM; "\n" escapes allowed) are all set. APPLE_APP_BUNDLE_IDENTIFIER lets the app sign in natively with an ID token.
 * The client secret is a 180-day ES256 JWT minted at startup (Apple's limit is six months), so restart within 180 days.
 */
function appleProvider(env: NodeJS.ProcessEnv): BetterAuthOptions['socialProviders'] {
  const { APPLE_CLIENT_ID: clientId, APPLE_TEAM_ID: teamId, APPLE_KEY_ID: keyId, APPLE_PRIVATE_KEY: rawKey } = env;
  const set = [clientId, teamId, keyId, rawKey].filter(Boolean).length;
  if (set === 0) return undefined;
  if (!clientId || !teamId || !keyId || !rawKey) {
    throw new Error('Sign in with Apple needs APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY together');
  }
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'ES256', kid: keyId })}.${part({ iss: teamId, iat: now, exp: now + 180 * 24 * 60 * 60, aud: 'https://appleid.apple.com', sub: clientId })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: rawKey.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  const bundle = env.APPLE_APP_BUNDLE_IDENTIFIER;
  return {
    apple: { clientId, clientSecret: `${unsigned}.${signature.toString('base64url')}`, ...(bundle ? { appBundleIdentifier: bundle } : {}) },
  };
}

/**
 * The server half of @better-auth/expo 1.7.6, without its Expo peer dependencies: the Expo client sends its scheme as
 * `expo-origin` (React Native sends no Origin), and an OAuth callback that redirects into the app carries the session
 * cookie in the deep link.
 */
function expoServer(): BetterAuthPlugin {
  return {
    id: 'expo',
    async onRequest(request) {
      if (request.headers.get('origin')) return;
      const expoOrigin = request.headers.get('expo-origin');
      if (!expoOrigin) return;
      const headers = new Headers(request.headers);
      headers.set('origin', expoOrigin);
      return { request: new Request(request, { headers }) };
    },
    hooks: {
      after: [
        {
          matcher: (context) => Boolean(context.path?.startsWith('/callback')),
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.context.responseHeaders;
            const location = headers?.get('location');
            const cookie = headers?.get('set-cookie');
            if (!location || !cookie || !URL.canParse(location)) return;
            const redirect = new URL(location);
            if (redirect.protocol === 'http:' || redirect.protocol === 'https:' || !ctx.context.isTrustedOrigin(location)) return;
            redirect.searchParams.set('cookie', cookie);
            ctx.setHeader('location', redirect.toString());
          }),
        },
      ],
    },
  };
}

/** Opens (creating, 0600) auth.db, migrates it, and promotes PUFFER_ADMIN_EMAILS users that already exist. */
export async function openAccounts(options: AccountsOptions): Promise<Accounts> {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  const path = join(options.stateDir, 'auth.db');
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  const adminEmails = new Set(list(options.env.PUFFER_ADMIN_EMAILS).map((email) => email.toLowerCase()));
  const adminUserIds = list(options.env.PUFFER_ADMIN_USER_IDS);
  const apple = appleProvider(options.env);

  const authOptions = {
    appName: 'Puffer',
    baseURL: options.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: secretFor(options),
    database: db,
    emailAndPassword: { enabled: true },
    ...(apple ? { socialProviders: apple } : {}),
    user: { deleteUser: { enabled: true } },
    trustedOrigins: [APP_ORIGIN, ...(apple ? ['https://appleid.apple.com'] : []), ...(options.production ? [] : ['exp://'])],
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    telemetry: { enabled: false },
    plugins: [bearer(), admin(adminUserIds.length ? { adminUserIds } : {}), expoServer()],
    databaseHooks: {
      user: {
        create: {
          // An address listed in PUFFER_ADMIN_EMAILS becomes admin when it signs up.
          before: async (user) => (adminEmails.has(user.email.toLowerCase()) ? { data: { ...user, role: 'admin' } } : undefined),
        },
        delete: {
          after: async (user) => options.onUserDeleted(user.id),
        },
      },
    },
  } satisfies BetterAuthOptions;

  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
  const promote = db.prepare(`UPDATE "user" SET role = 'admin' WHERE lower(email) = ? AND (role IS NULL OR role <> 'admin')`);
  for (const email of adminEmails) promote.run(email);

  const auth = betterAuth(authOptions);
  const handler = toNodeHandler(auth);
  const isAdmin = (userId: string, role: unknown) =>
    adminUserIds.includes(userId) || (typeof role === 'string' && role.split(',').map((r) => r.trim()).includes('admin'));

  return {
    handle: (req, res) => handler(req, res),
    session: async (headers) => {
      const found = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
      if (!found || found.user.banned) return null;
      return { userId: found.user.id, email: found.user.email, admin: isAdmin(found.user.id, found.user.role) };
    },
    emails: (userIds) => {
      const select = db.prepare('SELECT email FROM "user" WHERE id = ?');
      const found = new Map<string, string>();
      for (const id of new Set(userIds)) {
        const row = select.get(id) as { email?: unknown } | undefined;
        if (typeof row?.email === 'string') found.set(id, row.email);
      }
      return found;
    },
    userCount: () => Number((db.prepare('SELECT count(*) AS n FROM "user"').get() as { n: number }).n),
  };
}
