// Who may talk to this relay. Each device (phone) is a tenant: its own agent registry, mailbox and notifier. The
// phone is the authority on its agents; the relay keeps key digests only. Two indexes, device key digest -> tenant and
// agent key digest -> (tenant, agent), resolve every bearer key to exactly one tenant, so a key never reaches another
// tenant's data. Persisted to the state file (0600) as digests, revisions, agent names and when each phone registered and
// last synced. A phone that never syncs, or has no agents and stops syncing, is pruned (lifecycle below). Single writer:
// this module.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { Mailbox, type MailboxOptions } from './mailbox';
import { Notifier, type NotifierOptions } from './notify';
import { operations, type Operations } from './operations';
import { KeyDigest, WireAgent, WireRegistry, type AgentId, type PhoneRegistry, type RequestId } from './protocol';

export const TenantId = z.string().regex(/^tn_[A-Za-z0-9_-]{22}$/).brand<'TenantId'>();
export type TenantId = z.infer<typeof TenantId>;

/** The agent a bearer credential names (oauth.claim): by key digest, and by tenant when a signed token says which. */
export type AgentClaim = { tenant: TenantId | null; agent: KeyDigest };

/** The phone's part: what its last accepted snapshot said. A lower revision is ignored; an equal one refreshes. */
export type Registry = { revision: number; agents: readonly WireAgent[] };

/** Epoch ms. A file from before these fields counts every tenant as registered and synced when it loads. */
const TenantRecord = WireRegistry.extend({
  id: TenantId,
  deviceKeyDigest: KeyDigest,
  registeredAt: z.number().optional(),
  lastSyncAt: z.number().nullable().optional(),
});
type TenantRecord = {
  readonly id: TenantId;
  readonly deviceKeyDigest: KeyDigest;
  readonly registeredAt: number;
  /** To the hour (SYNC_PERSIST_MS); null until the phone's first sync. */
  lastSyncAt: number | null;
  registry: Registry;
};

const StateFile = z.object({ tenants: z.array(TenantRecord) });
/** The single-device file from before tenants. It becomes the first tenant. */
const LegacyStateFile = WireRegistry.extend({ deviceKeyDigest: KeyDigest });

/** A tenant this process is serving: created on first use, dropped after IDLE_EVICT_MS without a sync or agent call. */
export type Tenant = {
  readonly id: TenantId;
  readonly record: TenantRecord;
  readonly mailbox: Mailbox;
  readonly notifier: Notifier;
  readonly operations: Operations;
  /** This process accepted a snapshot from the phone. Notify config lives in memory, so until then the relay asks for one. */
  registryAccepted: boolean;
  /** The first sync was answered at once to ask for the snapshot. */
  registryAsked: boolean;
  lastActiveAt: number;
};

/** Mailboxes hold requests at most 24 h, so after two idle days nothing is lost but read cursors and cached pages. */
const IDLE_EVICT_MS = 48 * 60 * 60_000;

const LIFECYCLE = {
  /** A registered phone that has not synced by then never will: the app failed to keep its key. */
  firstSyncWithinMs: 24 * 60 * 60_000,
  /** A phone this long without a sync is idle: it no longer counts against maxDevices, and without agents it is pruned. */
  idleAfterMs: 30 * 24 * 60 * 60_000,
};
/** lastSyncAt is persisted at most this often, so a sync every 25 s does not rewrite the file. */
const SYNC_PERSIST_MS = 60 * 60_000;

/**
 * Pure. `pending`: registered, waiting for its first sync. `active`: synced within idleAfterMs. `idle`: kept for its
 * agents but not counted. `prune`: never synced in time, or idle with no agents.
 */
function lifecycle(record: Pick<TenantRecord, 'registeredAt' | 'lastSyncAt' | 'registry'>, now: number): 'pending' | 'active' | 'idle' | 'prune' {
  if (record.lastSyncAt === null) return now - record.registeredAt < LIFECYCLE.firstSyncWithinMs ? 'pending' : 'prune';
  if (now - record.lastSyncAt < LIFECYCLE.idleAfterMs) return 'active';
  return record.registry.agents.length > 0 ? 'idle' : 'prune';
}

export type TenantsOptions = {
  path: string;
  mailbox: MailboxOptions;
  notifier: NotifierOptions;
  /** The relay's /open/<id> link. */
  openUrl: (id: RequestId) => string;
};

export function digestKey(key: string): KeyDigest {
  return KeyDigest.parse(`sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`);
}

const mintDeviceKey = () => `dk_${randomBytes(32).toString('base64url')}`;
const mintTenantId = () => TenantId.parse(`tn_${randomBytes(16).toString('base64url')}`);

export class Tenants {
  private readonly records = new Map<TenantId, TenantRecord>();
  private readonly devices = new Map<KeyDigest, TenantId>();
  private readonly agentKeys = new Map<KeyDigest, { tenantId: TenantId; agent: WireAgent }>();
  private readonly live = new Map<TenantId, Tenant>();

  /**
   * Loads the state file, migrating a single-device file into one tenant, and prunes at once. No file: no tenants until a
   * phone registers.
   */
  static open(options: TenantsOptions): Tenants {
    const tenants = new Tenants(options);
    if (!existsSync(options.path)) return tenants;
    const raw: unknown = JSON.parse(readFileSync(options.path, 'utf8'));
    const loadedAt = Date.now();
    const legacy = LegacyStateFile.safeParse(raw);
    if (legacy.success) {
      const { deviceKeyDigest, revision, agents } = legacy.data;
      tenants.add({ id: mintTenantId(), deviceKeyDigest, registeredAt: loadedAt, lastSyncAt: loadedAt, registry: { revision, agents } });
      tenants.save();
    } else {
      for (const { id, deviceKeyDigest, registeredAt, lastSyncAt, revision, agents } of StateFile.parse(raw).tenants) {
        const synced = lastSyncAt === undefined ? loadedAt : lastSyncAt;
        tenants.add({ id, deviceKeyDigest, registeredAt: registeredAt ?? loadedAt, lastSyncAt: synced, registry: { revision, agents } });
      }
    }
    tenants.prune();
    return tenants;
  }

  private constructor(private readonly options: TenantsOptions) {}

  get count(): number {
    return this.records.size;
  }

  /** What counts against maxDevices: tenants pending their first sync or active. */
  activeCount(): number {
    const now = Date.now();
    let active = 0;
    for (const record of this.records.values()) if (['pending', 'active'].includes(lifecycle(record, now))) active++;
    return active;
  }

  /** POST /v1/device/register: a new tenant and its device key, shown once. Saved before it is returned. */
  register(): { id: TenantId; deviceKey: string } {
    const deviceKey = mintDeviceKey();
    const id = mintTenantId();
    this.add({ id, deviceKeyDigest: digestKey(deviceKey), registeredAt: Date.now(), lastSyncAt: null, registry: { revision: 0, agents: [] } });
    this.save();
    return { id, deviceKey };
  }

  /** The phone synced. */
  synced(tenant: Tenant): void {
    const now = Date.now();
    const { record } = tenant;
    if (record.lastSyncAt !== null && now - record.lastSyncAt < SYNC_PERSIST_MS) return;
    record.lastSyncAt = now;
    this.save();
  }

  /** The tenant a device bearer key names. Null for a pruned or never registered key: the phone registers again. */
  device(authorization: string | undefined): Tenant | null {
    const key = bearer(authorization, 'dk_');
    const id = key === null ? undefined : this.devices.get(digestKey(key));
    return id === undefined ? null : this.serve(id);
  }

  /** The tenant and agent a claim names, unless no phone registered it, or a claimed tenant's phone did not. */
  agent(claim: AgentClaim | null): { tenant: Tenant; agent: WireAgent } | null {
    const found = claim && this.agentKeys.get(claim.agent);
    if (!found || (claim.tenant !== null && claim.tenant !== found.tenantId)) return null;
    return { tenant: this.serve(found.tenantId), agent: found.agent };
  }

  /** Whether this tenant's registry holds an agent with this digest. */
  knowsKey(tenantId: TenantId, digest: KeyDigest): boolean {
    return this.agentKeys.get(digest)?.tenantId === tenantId;
  }

  /**
   * Applies the phone's snapshot (see applyPhoneRegistry), saving and re-indexing only on a real change. An agent whose
   * digest another tenant already holds is dropped: one key, one tenant. `agents` is the snapshot without those.
   */
  applyRegistry(tenant: Tenant, wire: PhoneRegistry): { accepted: boolean; removed: AgentId[]; agents: PhoneRegistry['agents'] } {
    const claimed = wire.agents.filter(({ keyDigest }) => {
      const holder = this.agentKeys.get(keyDigest)?.tenantId;
      if (holder === undefined || holder === tenant.id) return true;
      console.warn(`registry: tenant ${tenant.id} named an agent key another tenant holds; ignored`);
      return false;
    });
    const applied = applyPhoneRegistry(tenant.record.registry, { ...wire, agents: claimed });
    if (applied.registry !== tenant.record.registry) {
      this.unindex(tenant.record);
      tenant.record.registry = applied.registry;
      this.index(tenant.record);
      this.save();
    }
    return { accepted: applied.accepted, removed: applied.removed, agents: claimed };
  }

  sweep(): void {
    this.prune();
    const now = Date.now();
    for (const [id, tenant] of this.live) {
      if (now - tenant.lastActiveAt >= IDLE_EVICT_MS) {
        tenant.notifier.revoke(tenant.record.registry.agents.map((agent) => agent.id));
        this.live.delete(id);
        continue;
      }
      tenant.mailbox.sweep();
      tenant.notifier.sweep();
    }
  }

  save(): void {
    const tenants = [...this.records.values()].map(({ id, deviceKeyDigest, registeredAt, lastSyncAt, registry }) => ({
      id,
      deviceKeyDigest,
      registeredAt,
      lastSyncAt,
      ...registry,
    }));
    writeStateFile(this.options.path, { tenants });
  }

  private prune(): void {
    const now = Date.now();
    const pruned = [...this.records.values()].filter((record) => lifecycle(record, now) === 'prune');
    for (const record of pruned) this.remove(record);
    if (pruned.length === 0) return;
    console.log(`registry: pruned ${pruned.length} device(s) that never synced or idled without agents`);
    this.save();
  }

  private add(record: TenantRecord): void {
    this.records.set(record.id, record);
    this.devices.set(record.deviceKeyDigest, record.id);
    this.index(record);
  }

  /** Its device key and agent keys stop resolving; OAuth sessions of its agents go at their next sweep. */
  private remove(record: TenantRecord): void {
    this.records.delete(record.id);
    this.devices.delete(record.deviceKeyDigest);
    this.unindex(record);
    const live = this.live.get(record.id);
    if (!live) return;
    live.notifier.revoke(record.registry.agents.map((agent) => agent.id));
    this.live.delete(record.id);
  }

  private index(record: TenantRecord): void {
    for (const agent of record.registry.agents) {
      if (!this.agentKeys.has(agent.keyDigest)) this.agentKeys.set(agent.keyDigest, { tenantId: record.id, agent });
    }
  }

  private unindex(record: TenantRecord): void {
    for (const agent of record.registry.agents) {
      if (this.agentKeys.get(agent.keyDigest)?.tenantId === record.id) this.agentKeys.delete(agent.keyDigest);
    }
  }

  /** The live tenant, created on first use. Every authenticated call counts as activity. */
  private serve(id: TenantId): Tenant {
    let tenant = this.live.get(id);
    if (!tenant) {
      const record = this.records.get(id);
      if (!record) throw new Error(`tenant ${id} is indexed but has no record`);
      const mailbox = new Mailbox(this.options.mailbox);
      tenant = {
        id,
        record,
        mailbox,
        notifier: new Notifier(this.options.notifier),
        operations: operations(mailbox, this.options.openUrl),
        registryAccepted: false,
        registryAsked: false,
        lastActiveAt: Date.now(),
      };
      this.live.set(id, tenant);
    }
    tenant.lastActiveAt = Date.now();
    return tenant;
  }
}

/** Atomic replace, readable by the owner only. Each state file has one writer module. */
export function writeStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function bearer(authorization: string | undefined, prefix: 'dk_'): string | null {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  return token?.startsWith(prefix) ? token : null;
}

/**
 * Full replace from the phone's snapshot when wire.revision >= registry.revision; an equal revision is a refresh,
 * as after a relay restart. An unchanged persisted part returns the same registry object, so the caller saves only
 * real changes. `removed` names agents that lost access; the caller settles their open requests as disconnected.
 */
export function applyPhoneRegistry(
  registry: Registry,
  wire: PhoneRegistry,
): { accepted: boolean; registry: Registry; removed: AgentId[] } {
  if (wire.revision < registry.revision) return { accepted: false, registry, removed: [] };
  const agents = wire.agents.map(({ id, name, keyDigest }) => ({ id, name, keyDigest }));
  if (wire.revision === registry.revision && isDeepStrictEqual(agents, registry.agents)) return { accepted: true, registry, removed: [] };
  const kept = new Set(agents.map((agent) => agent.id));
  return {
    accepted: true,
    registry: { revision: wire.revision, agents },
    removed: registry.agents.filter((agent) => !kept.has(agent.id)).map((agent) => agent.id),
  };
}
