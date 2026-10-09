// `npm run e2e:auth`. Accounts (Better Auth at /api/auth), device self-management and the operator's admin routes:
// starts the real relay as a child process, signs users up and in over HTTP, plays the phone, and prints one PASS/FAIL
// line per assertion.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RELAY_DIR = resolve(import.meta.dirname, '..');
const ADMIN_EMAIL = 'operator@puffer.test';
const PASSWORD = 'correct horse battery staple';
/** Nothing from the developer's shell may change what is tested. */
const CLEAN_ENV = { NODE_ENV: '', BETTER_AUTH_SECRET: '', PUFFER_ADMIN_EMAILS: '', PUFFER_ADMIN_USER_IDS: '', PUFFER_OPEN_REGISTER: '', PUFFER_ADMIN_TOKEN: '', APPLE_CLIENT_ID: '' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
}

const digest = (key: string) => `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;

type Relay = { base: string; stop: () => Promise<void> };

/** The startup pattern of e2e.ts: port 0, and the bound port read from the relay's banner. */
async function startRelay(statePath: string, args: string[] = [], env: Record<string, string> = {}): Promise<Relay> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--port', '0', '--state', statePath, '--wait-ms', '1500', ...args], {
    cwd: RELAY_DIR,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...CLEAN_ENV, ...env },
  });
  let out = '';
  const base = await new Promise<string>((ready, fail) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      const port = /Puffer relay on \S+ \(listening on \S+:(\d+),/.exec(out)?.[1];
      if (port) ready(`http://localhost:${port}`);
    });
    child.once('exit', (code) => fail(new Error(`relay exited with ${code}\n${out}`)));
  });
  return {
    base,
    stop: () =>
      new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
      }),
  };
}

/** Exits non-zero with `expected` in its stderr when the relay refuses to start. */
function startFails(statePath: string, args: string[], env: Record<string, string>, expected: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', '--port', '0', '--state', statePath, ...args], {
      cwd: RELAY_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...CLEAN_ENV, ...env },
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    child.once('exit', (code) => done(code !== 0 && err.includes(expected)));
  });
}

type Answer = { status: number; json: Record<string, any>; headers: Headers };

async function call(base: string, method: string, path: string, bearer: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') ? (JSON.parse(text) as Record<string, any>) : { text }, headers: res.headers };
}

type User = { id: string; email: string; token: string };

/** POST /api/auth/sign-up/email, as the app's Better Auth client does (it sends its scheme as expo-origin). */
async function signUp(base: string, name: string, email: string): Promise<User> {
  const { status, json } = await call(base, 'POST', '/api/auth/sign-up/email', null, { name, email, password: PASSWORD }, { 'expo-origin': 'puffer://' });
  if (status !== 200) throw new Error(`sign-up of ${email} answered ${status}: ${JSON.stringify(json)}`);
  return { id: String(json.user?.id), email, token: String(json.token) };
}

/** POST /v1/device/register with the account's session token. */
async function register(base: string, user: User | null): Promise<{ deviceId: string; deviceKey: string }> {
  const { status, json } = await call(base, 'POST', '/v1/device/register', user?.token ?? null, { v: 1 });
  if (status !== 200) throw new Error(`register answered ${status}: ${JSON.stringify(json)}`);
  return { deviceId: String(json.deviceId), deviceKey: String(json.deviceKey) };
}

const sync = (base: string, deviceKey: string, extra: Record<string, unknown> = {}) =>
  call(base, 'POST', '/v1/device/sync', deviceKey, { v: 1, waitMs: 0, outbox: [], requestKinds: ['ask', 'recent', 'changes', 'sources', 'getNote'], ...extra });

/** An agent key the phone minted, made known to the relay by digest, as Puffer does in its registry snapshot. */
async function addAgent(base: string, deviceKey: string, revision: number, agents: { id: string; name: string; keyDigest: string }[]) {
  const { status } = await sync(base, deviceKey, { registry: { revision, agents } });
  if (status !== 200) throw new Error(`registry sync answered ${status}`);
}

/** POST /v1/connect -> by-link -> confirm. Returns the connection and its key digest. */
async function linkConnection(base: string, deviceKey: string, name: string) {
  const asked = (await call(base, 'POST', '/v1/connect', null, { name })).json;
  const secret = String(asked.approve_url).split('/c/')[1] ?? '';
  const keyDigest = String((await call(base, 'GET', `/v1/device/connects/by-link/${secret}`, deviceKey)).json.connect?.keyDigest);
  const confirmed = await call(base, 'POST', `/v1/device/connects/${asked.connect_id}/confirm`, deviceKey, { v: 1, link: secret });
  return { id: String(asked.connect_id), pollToken: String(asked.poll_token), keyDigest, confirmed: confirmed.json.status === 'confirmed' };
}

const agentStatus = async (base: string, key: string) => (await call(base, 'GET', '/v1/sources?wait=0', key)).status;

async function deviceRoutes(dir: string): Promise<void> {
  const statePath = join(dir, 'device', 'registry.json');
  const relay = await startRelay(statePath);
  const { base } = relay;
  try {
    const alice = await signUp(base, 'Alice', 'alice@puffer.test');
    const first = await register(base, alice);
    const rotated = await call(base, 'POST', '/v1/device/rotate', first.deviceKey, {});
    const newKey = String(rotated.json.deviceKey);
    const oldSync = await sync(base, first.deviceKey);
    const newSync = await sync(base, newKey);
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as { tenants: { id: string; deviceKeyDigest: string; userId?: string }[] };
    const stored = onDisk.tenants.find((tenant) => tenant.id === first.deviceId);
    check(
      'POST /v1/device/rotate returns a new dk_ key for the same device; the old key gets 401 unknown_device at once, the new one syncs, and the file holds only the new digest (and the owning user id)',
      rotated.status === 200 &&
        rotated.json.deviceId === first.deviceId &&
        /^dk_[\w-]{43}$/.test(newKey) &&
        newKey !== first.deviceKey &&
        oldSync.status === 401 &&
        oldSync.json.error === 'unknown_device' &&
        newSync.status === 200 &&
        stored?.deviceKeyDigest === digest(newKey) &&
        stored.userId === alice.id,
      { rotated, oldSync: oldSync.status, newSync: newSync.status, stored },
    );
    const rotateOld = await call(base, 'POST', '/v1/device/rotate', first.deviceKey, {});
    const rotateGet = await call(base, 'GET', '/v1/device/rotate', newKey);
    check('rotating with the old key is 401, and GET /v1/device/rotate is 405', rotateOld.status === 401 && rotateGet.status === 405, { rotateOld, rotateGet });

    // A key-minted agent, and a link agent through the whole connect flow.
    const direct = { id: 'ag_direct', name: 'Direct agent', key: `ak_${randomBytes(32).toString('base64url')}` };
    const wireDirect = { id: direct.id, name: direct.name, keyDigest: digest(direct.key) };
    await addAgent(base, newKey, 1, [wireDirect]);
    const linked = await linkConnection(base, newKey, 'Link agent');
    await addAgent(base, newKey, 2, [wireDirect, { id: 'ag_link', name: 'Link agent', keyDigest: linked.keyDigest }]);
    const collected = await call(base, 'POST', `/v1/connect/${linked.id}/token`, linked.pollToken, {});
    const linkKey = String(collected.json.key);
    const pendingLink = await linkConnection(base, newKey, 'Waiting agent');

    const account = await call(base, 'GET', '/v1/device', newKey);
    check(
      'GET /v1/device answers the device id, registeredAt, lastSyncAt, lifecycle, agent count, online and queued writes, and nothing else: no names, keys or digests',
      account.status === 200 &&
        account.json.deviceId === first.deviceId &&
        typeof account.json.registeredAt === 'string' &&
        typeof account.json.lastSyncAt === 'string' &&
        account.json.lifecycle === 'active' &&
        account.json.agentCount === 2 &&
        typeof account.json.online === 'boolean' &&
        account.json.queuedWrites === 0 &&
        !/sha256:|ak_|dk_|Direct agent/.test(JSON.stringify(account.json)),
      account,
    );
    const noKey = await call(base, 'GET', '/v1/device', null);
    const sessionAsDevice = await call(base, 'GET', '/v1/device', alice.token);
    check(
      'GET /v1/device without a device key, with an agent key, or with an account session token is 401: the session only registers',
      noKey.status === 401 && (await call(base, 'GET', '/v1/device', direct.key)).status === 401 && sessionAsDevice.status === 401,
      { noKey, sessionAsDevice },
    );

    const before = [await agentStatus(base, direct.key), await agentStatus(base, linkKey)];
    check(
      'both agents reach the API before the delete (the link agent collected its key through /v1/connect)',
      collected.status === 200 && linked.confirmed && pendingLink.confirmed && before.every((status) => status !== 401),
      { collected, before },
    );

    const other = await register(base, alice);
    const deleted = await call(base, 'DELETE', '/v1/device', newKey);
    const after = await Promise.all([
      sync(base, newKey).then((r) => r.status),
      call(base, 'GET', '/v1/device', newKey).then((r) => r.status),
      call(base, 'POST', '/v1/device/rotate', newKey, {}).then((r) => r.status),
      call(base, 'DELETE', '/v1/device', newKey).then((r) => r.status),
      agentStatus(base, direct.key),
      agentStatus(base, linkKey),
      call(base, 'POST', '/mcp', direct.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' }).then((r) => r.status),
    ]);
    const waiting = await call(base, 'POST', `/v1/connect/${pendingLink.id}/token`, pendingLink.pollToken, {});
    const fileAfter = readFileSync(statePath, 'utf8');
    const otherStill = await sync(base, other.deviceKey);
    check(
      'DELETE /v1/device answers deleted; afterwards the device key gets 401 on sync, GET, rotate and DELETE, both agent keys get 401 on /v1 and /mcp, a connection the device had confirmed polls access_denied, the file no longer names the device or its agents, and another device is untouched',
      deleted.status === 200 &&
        deleted.json.deleted === true &&
        after.every((status) => status === 401) &&
        waiting.status === 400 &&
        waiting.json.error === 'access_denied' &&
        !fileAfter.includes(first.deviceId) &&
        !fileAfter.includes(wireDirect.keyDigest) &&
        !fileAfter.includes(linked.keyDigest) &&
        fileAfter.includes(other.deviceId) &&
        otherStill.status === 200,
      { deleted, after, waiting, otherStill: otherStill.status },
    );
    const sessions = join(dir, 'device', 'oauth-sessions.json');
    let sessionsText = '';
    try {
      sessionsText = readFileSync(sessions, 'utf8');
    } catch {
      // No session was ever written.
    }
    check('no OAuth session of the deleted device remains on disk', !sessionsText.includes(first.deviceId), sessionsText);

    const admin = await Promise.all([
      call(base, 'GET', '/v1/admin/devices', alice.token),
      call(base, 'GET', '/v1/admin/stats', alice.token),
      call(base, 'DELETE', `/v1/admin/devices/${other.deviceId}`, alice.token),
    ]);
    const anonymous = await Promise.all([call(base, 'GET', '/v1/admin/devices', null), call(base, 'GET', '/v1/admin/stats', other.deviceKey)]);
    check(
      'a signed-in account that is not an admin gets 403 forbidden on every /v1/admin route; no session (or a device key) is 401 with a Bearer challenge',
      admin.every((r) => r.status === 403 && r.json.error === 'forbidden') &&
        anonymous.every((r) => r.status === 401 && r.json.error === 'invalid_token' && /Bearer/.test(r.headers.get('www-authenticate') ?? '')),
      { admin, anonymous },
    );

    // Self-service account deletion (Better Auth delete-user) takes the account's devices with it.
    const carol = await signUp(base, 'Carol', 'carol@puffer.test');
    const carolDevice = await register(base, carol);
    const selfDelete = await call(base, 'POST', '/api/auth/delete-user', carol.token, { password: PASSWORD }, { 'expo-origin': 'puffer://' });
    const carolSync = await sync(base, carolDevice.deviceKey);
    const carolSession = await call(base, 'GET', '/api/auth/get-session', carol.token);
    check(
      'POST /api/auth/delete-user with the password deletes the account and its device: the device key gets 401 unknown_device, the session is gone, and alice\'s device is untouched',
      selfDelete.status === 200 &&
        carolSync.status === 401 &&
        carolSync.json.error === 'unknown_device' &&
        (carolSession.json.text === 'null' || carolSession.json.user === undefined) &&
        !readFileSync(statePath, 'utf8').includes(carolDevice.deviceId) &&
        (await sync(base, other.deviceKey)).status === 200,
      { selfDelete, carolSync, carolSession },
    );
  } finally {
    await relay.stop();
  }
}

async function accountRoutes(dir: string): Promise<void> {
  const statePath = join(dir, 'accounts', 'registry.json');
  const env = { PUFFER_ADMIN_EMAILS: `someone-else@puffer.test, ${ADMIN_EMAIL.toUpperCase()}` };
  const args = ['--max-devices-per-user', '2'];
  let relay = await startRelay(statePath, args, env);
  try {
    let { base } = relay;
    const signedUp = await call(base, 'POST', '/api/auth/sign-up/email', null, { name: 'Bob', email: 'bob@puffer.test', password: PASSWORD }, { 'expo-origin': 'puffer://' });
    const bob: User = { id: String(signedUp.json.user?.id), email: 'bob@puffer.test', token: String(signedUp.json.token) };
    const signedIn = await call(base, 'POST', '/api/auth/sign-in/email', null, { email: bob.email, password: PASSWORD }, { 'expo-origin': 'puffer://' });
    const wrongPassword = await call(base, 'POST', '/api/auth/sign-in/email', null, { email: bob.email, password: 'not the password' }, { 'expo-origin': 'puffer://' });
    const foreignOrigin = await call(base, 'POST', '/api/auth/sign-in/email', null, { email: bob.email, password: PASSWORD }, { origin: 'https://evil.example' });
    const session = await call(base, 'GET', '/api/auth/get-session', String(signedIn.json.token));
    const signedToken = signedIn.headers.get('set-auth-token') ?? '';
    const sessionBySignedToken = await call(base, 'GET', '/api/auth/get-session', signedToken);
    check(
      'sign-up and sign-in over /api/auth (email + password, from the app scheme) answer a session token, also as set-auth-token; a wrong password is 401, a foreign Origin 403; GET /api/auth/get-session with Authorization: Bearer <token> names the user, a plain "user" role',
      signedUp.status === 200 &&
        signedUp.json.user?.role === 'user' &&
        typeof signedUp.json.token === 'string' &&
        signedIn.status === 200 &&
        signedToken.startsWith(String(signedIn.json.token)) &&
        wrongPassword.status === 401 &&
        foreignOrigin.status === 403 &&
        session.status === 200 &&
        session.json.user?.id === bob.id &&
        sessionBySignedToken.json.user?.id === bob.id,
      { signedUp, signedIn: signedIn.status, wrongPassword: wrongPassword.status, foreignOrigin, session },
    );
    check(
      'auth.db and auth-secret sit next to registry.json, owner-only',
      ['auth.db', 'auth-secret'].every((name) => (statSync(join(dir, 'accounts', name)).mode & 0o777) === 0o600),
    );

    const anonymous = await call(base, 'POST', '/v1/device/register', null, { v: 1 });
    const forged = await call(base, 'POST', '/v1/device/register', 'not-a-session-token', { v: 1 });
    check(
      'POST /v1/device/register without a session, or with a bogus token, is 401 sign_in_required and mints no device',
      anonymous.status === 401 && anonymous.json.error === 'sign_in_required' && forged.status === 401 && !/deviceKey/.test(JSON.stringify([anonymous, forged])),
      { anonymous, forged },
    );
    const phone = await register(base, bob);
    const ipad = await register(base, bob);
    const third = await call(base, 'POST', '/v1/device/register', bob.token, { v: 1 });
    check(
      'a signed-in user registers devices up to the per-user cap (--max-devices-per-user 2); the next is 403 device_limit',
      /^tn_/.test(phone.deviceId) && /^tn_/.test(ipad.deviceId) && third.status === 403 && third.json.error === 'device_limit',
      third,
    );
    await addAgent(base, phone.deviceKey, 1, [{ id: 'ag_one', name: 'Agent One', keyDigest: digest(`ak_${randomBytes(32).toString('base64url')}`) }]);

    const operator = await signUp(base, 'Operator', ADMIN_EMAIL);
    const listed = await call(base, 'GET', '/v1/admin/devices', operator.token);
    const devices = (listed.json.devices ?? []) as Record<string, any>[];
    const byId = (id: string) => devices.find((device) => device.deviceId === id);
    check(
      'an account whose email is in PUFFER_ADMIN_EMAILS (any case) is admin: GET /v1/admin/devices lists every device with its userId and email, registeredAt, lastSyncAt, lifecycle, agent count and names, online, queued writes, and no key or digest',
      listed.status === 200 &&
        devices.length === 2 &&
        byId(phone.deviceId)?.userId === bob.id &&
        byId(phone.deviceId)?.email === bob.email &&
        byId(ipad.deviceId)?.userId === bob.id &&
        byId(phone.deviceId)?.agentCount === 1 &&
        byId(phone.deviceId)?.agents?.[0]?.name === 'Agent One' &&
        byId(phone.deviceId)?.lifecycle === 'active' &&
        byId(ipad.deviceId)?.lifecycle === 'pending' &&
        byId(ipad.deviceId)?.lastSyncAt === null &&
        devices.every((device) => typeof device.online === 'boolean' && typeof device.registeredAt === 'string' && device.queuedWrites === 0) &&
        !/sha256:|ak_|dk_/.test(JSON.stringify(listed.json)),
      listed,
    );
    const stats = await call(base, 'GET', '/v1/admin/stats', operator.token);
    check(
      'GET /v1/admin/stats counts devices by lifecycle, users, agents and queued writes',
      stats.status === 200 && stats.json.devices === 2 && stats.json.active === 1 && stats.json.pending === 1 && stats.json.users === 2 && stats.json.agents === 1 && stats.json.queuedWrites === 0,
      stats,
    );
    const users = await call(base, 'GET', '/api/auth/admin/list-users', operator.token);
    const bobListsUsers = await call(base, 'GET', '/api/auth/admin/list-users', bob.token);
    const bobAdmin = await call(base, 'GET', '/v1/admin/devices', bob.token);
    check(
      'the admin lists users at /api/auth/admin/list-users (admin plugin); bob cannot, and gets 403 on /v1/admin',
      users.status === 200 && users.json.total === 2 && bobListsUsers.status === 403 && bobAdmin.status === 403,
      { users: users.status, bobListsUsers: bobListsUsers.status, bobAdmin },
    );

    // The admin's session and the minted secret survive a restart.
    await relay.stop();
    relay = await startRelay(statePath, args, env);
    ({ base } = relay);

    const removedDevice = await call(base, 'DELETE', `/v1/admin/devices/${ipad.deviceId}`, operator.token);
    const again = await call(base, 'DELETE', `/v1/admin/devices/${ipad.deviceId}`, operator.token);
    const malformed = await call(base, 'DELETE', '/v1/admin/devices/nope', operator.token);
    const wrongMethod = await call(base, 'POST', '/v1/admin/devices', operator.token, {});
    check(
      'after a restart the admin session still works: DELETE /v1/admin/devices/<id> removes one device (its key then gets 401); a second delete and a malformed id are 404; POST /v1/admin/devices is 405',
      removedDevice.status === 200 &&
        removedDevice.json.deleted === true &&
        (await sync(base, ipad.deviceKey)).status === 401 &&
        again.status === 404 &&
        malformed.status === 404 &&
        wrongMethod.status === 405,
      { removedDevice, again, malformed, wrongMethod },
    );

    const removedUser = await call(base, 'POST', '/api/auth/admin/remove-user', operator.token, { userId: bob.id });
    const bobSync = await sync(base, phone.deviceKey);
    const bobSession = await call(base, 'GET', '/api/auth/get-session', bob.token);
    const afterStats = await call(base, 'GET', '/v1/admin/stats', operator.token);
    check(
      'POST /api/auth/admin/remove-user deletes bob and his devices: his device key gets 401 unknown_device, his session is gone, registry.json no longer names him, stats drop to 0 devices and 1 user',
      removedUser.status === 200 &&
        bobSync.status === 401 &&
        bobSync.json.error === 'unknown_device' &&
        (bobSession.json.text === 'null' || bobSession.json.user === undefined) &&
        !readFileSync(statePath, 'utf8').includes(bob.id) &&
        afterStats.json.devices === 0 &&
        afterStats.json.users === 1,
      { removedUser, bobSync, bobSession, afterStats },
    );

    const failures: number[] = [];
    for (let i = 0; i < 10; i++) failures.push((await call(base, 'GET', '/v1/admin/stats', i % 2 ? bob.token : 'not-a-session')).status);
    const blocked = await call(base, 'GET', '/v1/admin/stats', 'still-wrong');
    const blockedAdmin = await call(base, 'GET', '/v1/admin/stats', operator.token);
    check(
      'failed admin authentications are 401; after 10 failures from one address the caller gets 429, even with an admin session',
      failures.every((status) => status === 401) && blocked.status === 429 && blockedAdmin.status === 429,
      { failures, blocked: blocked.status, blockedAdmin: blockedAdmin.status },
    );
  } finally {
    await relay.stop();
  }
}

async function startupChecks(dir: string): Promise<void> {
  check(
    'with NODE_ENV=production the relay refuses to start without BETTER_AUTH_SECRET',
    await startFails(join(dir, 'prod', 'registry.json'), [], { NODE_ENV: 'production' }, 'BETTER_AUTH_SECRET is required'),
  );
  check(
    'the relay refuses a BETTER_AUTH_SECRET shorter than 32 characters',
    await startFails(join(dir, 'short', 'registry.json'), [], { BETTER_AUTH_SECRET: 'too-short' }, 'at least 32'),
  );
  check(
    'with NODE_ENV=production the relay refuses --dev-open-register',
    await startFails(join(dir, 'open', 'registry.json'), ['--dev-open-register'], { NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url') }, 'development only'),
  );
  const relay = await startRelay(join(dir, 'open', 'registry.json'), ['--dev-open-register']);
  try {
    const open = await call(relay.base, 'POST', '/v1/device/register', null, { v: 1 });
    check('with --dev-open-register (dev and e2e.ts only) a device registers without a session', open.status === 200 && /^dk_/.test(String(open.json.deviceKey)), open);
  } finally {
    await relay.stop();
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'puffer-e2e-auth-'));
  try {
    await deviceRoutes(dir);
    await accountRoutes(dir);
    await startupChecks(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
