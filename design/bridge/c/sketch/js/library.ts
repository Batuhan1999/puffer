import type { Item } from '../../../../src/domain';

// Keeps the surface src/ingest.ts already uses (`library.add`, `library.index.has`, `library.clear`, `thumbsDir`),
// now forwarding to PufferCore. src/puffer.ts is deleted in the same change; callers move to the native search through store.search.
export class Library {
  static async open(): Promise<Library> { throw new Error('not implemented'); }
  readonly index: { has(id: string): boolean };   // answered from a Set of ids refreshed on `changed`
  add(item: Item, vec: Float32Array, thumbName?: string): Promise<void> { throw new Error('not implemented'); }
  clear(): Promise<void> { throw new Error('not implemented'); }
}
