// Fixed-window rate limits per key: per caller for OAuth, per agent for new requests.

import { isIP } from 'node:net';

export class RateLimit<K> {
  private readonly windows = new Map<K, { startedAt: number; count: number }>();

  /** Past `maxKeys` live windows a new key is refused, so a flood of callers cannot grow memory without bound. */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  take(key: K): boolean {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (!window && this.windows.size >= this.maxKeys) {
        for (const [stale, { startedAt }] of this.windows) if (now - startedAt >= this.windowMs) this.windows.delete(stale);
        if (this.windows.size >= this.maxKeys) return false;
      }
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    return ++window.count <= this.limit;
  }
}

/**
 * Who is calling, for per-caller limits: an IPv4 address, or the /64 of an IPv6 address, since one IPv6 subscriber
 * usually holds a whole /64. An IPv4-mapped address counts as its IPv4 address.
 */
export function callerKey(address: string): string {
  const plain = address.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)?.[1];
  if (mapped) return mapped;
  if (isIP(plain) !== 6) return plain;
  const [head = '', tail] = plain.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
