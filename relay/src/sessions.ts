// OAuth sessions: what an MCP client holds once the phone approved it. A session is one refresh-token family, bound to
// a client, a tenant and the agent the phone admitted, named by its key digest; that agent's ak_ key never leaves the
// relay. Access tokens are stateless, signed with the session key, and live an hour. Whoever checks one still asks the
// tenant's registry, so removing the agent in Puffer ends access at once. A refresh token rotates on every use and
// stays valid 90 days from its last use. Presenting one that already rotated revokes the session, and the phone is
// told to remove its agent, except within a minute of the rotation, when it gets the current token again. On disk,
// owner-only: the session key, and per session its binding, its rotation count and the digests of the current refresh
// token and the one it replaced. A refresh token is derived from the key, so the file never holds one. A session the
// file cannot describe is dropped at load, never the relay's start. Single writer: this module.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { KeyDigest } from './protocol';
import { TenantId, writeStateFile } from './registry';

const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_IDLE_MS = 90 * 24 * 60 * 60_000;
/** A client that lost the reply to a refresh may repeat it this long and gets the same reply token. */
const RETRY_GRACE_MS = 60_000;
/** A revoked record lives this long, so the phone hears to remove its agent even after a day offline. */
export const REVOKED_RETENTION_MS = 24 * 60 * 60_000;
/** The family part of a refresh token: the same in every token of a session, and found nowhere else. */
const FAMILY_BYTES = 16;

const Sha256 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const SessionId = Sha256.brand<'SessionId'>();
type SessionId = z.infer<typeof SessionId>;

const Session = z.object({
  /** The digest of the family part, so the file never holds a piece of a token. */
  id: SessionId,
  clientId: z.string(),
  tenant: TenantId,
  agent: KeyDigest,
  state: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('active'),
      refreshDigest: Sha256,
      expiresAt: z.number(),
      /** Rotations so far; the current token is derived from it. A session from before this field holds a random token. */
      rotation: z.number().int().min(0).default(0),
      /** The token the last rotation replaced: presented again before `until`, it is a retry, not a reuse. */
      previous: z
        .object({ digest: Sha256, until: z.number() })
        .nullish()
        .transform((previous) => previous ?? null),
    }),
    z.object({ kind: z.literal('revoked'), at: z.number() }),
  ]),
});
type Session = z.infer<typeof Session>;
type Active = Extract<Session['state'], { kind: 'active' }>;
const KeyFile = z.object({ key: Sha256 });
const AccessClaims = z.object({ tn: TenantId, ag: KeyDigest, exp: z.number().int() });

export type Grant = { clientId: string; tenant: TenantId; agent: KeyDigest };
export type TokenReply = { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string };

export type SessionsOptions = {
  path: string;
  keyPath: string;
  /** Whether this tenant's registry holds an agent with this digest. */
  knowsKey: (tenant: TenantId, agent: KeyDigest) => boolean;
};

export class Sessions {
  private readonly key: Buffer;
  private readonly sessions: Map<SessionId, Session>;

  constructor(private readonly options: SessionsOptions) {
    this.key = loadKey(options.keyPath);
    this.sessions = new Map(loadSessions(options.path).map((session) => [session.id, session]));
  }

  /** A new session for the agent a redeemed authorization code bought. */
  start(grant: Grant): TokenReply {
    const family = randomBytes(FAMILY_BYTES);
    const refreshToken = this.refreshTokenOf(family, 0);
    const id = sessionIdOf(family);
    this.sessions.set(id, { id, ...grant, state: active(refreshToken, Date.now(), 0, null) });
    this.save();
    return this.reply(grant, refreshToken);
  }

  /**
   * grant_type=refresh_token. The current token rotates. The one it replaced, repeated within RETRY_GRACE_MS, gets the
   * same reply token, so a lost reply is no logout. Any other token of the session revokes it. Returns why on refusal.
   */
  refresh(token: string, clientId: string): TokenReply | string {
    const family = familyOf(token);
    const session = family && this.sessions.get(sessionIdOf(family));
    if (!family || !session || session.state.kind !== 'active') return 'The refresh token is unknown, expired or revoked.';
    const now = Date.now();
    const presented = sha256(token);
    const { state } = session;
    const retry = state.previous !== null && state.previous.digest === presented && now < state.previous.until;
    if (presented !== state.refreshDigest && !retry) {
      console.warn(`oauth: a rotated refresh token was presented again; the session of ${session.clientId} is revoked`);
      this.revoke(session, now);
      return 'The refresh token was already used, so the session is revoked. Authorize again.';
    }
    if (session.clientId !== clientId) return 'The refresh token was issued to another client.';
    if (now >= state.expiresAt || !this.options.knowsKey(session.tenant, session.agent)) {
      return 'The refresh token is unknown, expired or revoked.';
    }
    if (retry) return this.reply(session, this.refreshTokenOf(family, state.rotation));
    const rotation = state.rotation + 1;
    const refreshToken = this.refreshTokenOf(family, rotation);
    session.state = active(refreshToken, now, rotation, { digest: presented, until: now + RETRY_GRACE_MS });
    this.save();
    return this.reply(session, refreshToken);
  }

  /** What a signed, unexpired access token claims. Whether that agent still counts is the registry's call. */
  verify(token: string): { tenant: TenantId; agent: KeyDigest } | null {
    const [, body, mac] = /^at_([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/.exec(token) ?? [];
    if (body === undefined || mac === undefined || !timingSafeEqual(Buffer.from(mac), Buffer.from(this.sign(body)))) return null;
    const claims = AccessClaims.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return claims.success && claims.data.exp * 1000 > Date.now() ? { tenant: claims.data.tn, agent: claims.data.ag } : null;
  }

  /** A redeemed authorization code presented again revokes the session it bought (OAuth 2.1 section 4.1.3). */
  revokeAgent(agent: KeyDigest): void {
    for (const session of this.sessions.values()) {
      if (session.agent === agent && session.state.kind === 'active') this.revoke(session, Date.now());
    }
  }

  isRevoked(agent: KeyDigest): boolean {
    for (const session of this.sessions.values()) if (session.agent === agent && session.state.kind === 'revoked') return true;
    return false;
  }

  /** Agents of this tenant's revoked sessions: their tokens fail, and the phone should remove them. */
  revokedAgents(tenant: TenantId): KeyDigest[] {
    return [...this.sessions.values()].filter((s) => s.tenant === tenant && s.state.kind === 'revoked').map((s) => s.agent);
  }

  /**
   * An idle session expires revoked, so the phone removes its agent. A session whose agent the phone removed is
   * forgotten, and a revoked one after REVOKED_RETENTION_MS.
   */
  sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, session] of this.sessions) {
      const { state } = session;
      if (state.kind === 'revoked' ? now - state.at >= REVOKED_RETENTION_MS : !this.options.knowsKey(session.tenant, session.agent)) {
        this.sessions.delete(id);
        changed = true;
      } else if (state.kind === 'active' && now >= state.expiresAt) {
        session.state = { kind: 'revoked', at: now };
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private revoke(session: Session, at: number): void {
    session.state = { kind: 'revoked', at };
    this.save();
  }

  private reply({ tenant, agent }: Grant, refreshToken: string): TokenReply {
    const claims = { tn: tenant, ag: agent, exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_S };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { access_token: `at_${body}.${this.sign(body)}`, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refreshToken };
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(`at_${body}`).digest('base64url');
  }

  /** rt_ plus the family part and 256 bits keyed on the session key, the family and the rotation, base64url. */
  private refreshTokenOf(family: Buffer, rotation: number): string {
    const mac = createHmac('sha256', this.key).update(Buffer.concat([Buffer.from('rt_'), family, Buffer.from(String(rotation))])).digest();
    return `rt_${Buffer.concat([family, mac]).toString('base64url')}`;
  }

  private save(): void {
    writeStateFile(this.options.path, { sessions: [...this.sessions.values()] });
  }
}

/** Each session the file describes; anything else is dropped with a warning, so a bad file never stops the relay. */
function loadSessions(path: string): Session[] {
  if (!existsSync(path)) return [];
  let entries: unknown[];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    entries = z.object({ sessions: z.array(z.unknown()) }).parse(raw).sessions;
  } catch {
    console.warn(`oauth: ${path} is not a sessions file; starting without OAuth sessions`);
    return [];
  }
  const sessions = entries.flatMap((entry) => Session.safeParse(entry).data ?? []);
  if (sessions.length < entries.length) console.warn(`oauth: dropped ${entries.length - sessions.length} unreadable session(s) from ${path}`);
  return sessions;
}

/** Minted once, beside the state file, so restarts and deploys keep every access token valid. */
function loadKey(path: string): Buffer {
  if (existsSync(path)) return Buffer.from(KeyFile.parse(JSON.parse(readFileSync(path, 'utf8'))).key, 'base64url');
  const key = randomBytes(32);
  writeStateFile(path, { key: key.toString('base64url') });
  return key;
}

const active = (refreshToken: string, now: number, rotation: number, previous: Active['previous']): Active => ({
  kind: 'active',
  refreshDigest: sha256(refreshToken),
  expiresAt: now + REFRESH_IDLE_MS,
  rotation,
  previous,
});

function familyOf(token: string): Buffer | null {
  return /^rt_[A-Za-z0-9_-]{64}$/.test(token) ? Buffer.from(token.slice(3), 'base64url').subarray(0, FAMILY_BYTES) : null;
}

const sessionIdOf = (family: Buffer) => SessionId.parse(createHash('sha256').update(family).digest('base64url'));

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64url');
