import Foundation

// The single search engine for the whole process. JS, the relay session and App Intents all call this one object.
// Replaces src/puffer.ts and the in-memory half of src/library.ts. Owns: vector matrix, BM25, row map, Store writes,
// Spotlight mirror trigger. Nothing else holds a copy of the index.

struct SearchRequest: Sendable {
  enum Subject: Sendable { case text(String), like(ItemID) }
  var subject: Subject
  var mode: Mode = .hybrid
  var dim: Int = 256
  var rerank: Bool = true
  var scope: RowScope = .everything
  /// Intents pass a deadline. If the model is not loaded in time, text search falls back to keyword mode.
  var embedDeadline: Duration? = nil
  enum Mode: String, Sendable { case vector, keyword, hybrid }
}

enum RowScope: Sendable {
  case everything
  case items(Set<ItemID>)
}

struct Hit: Sendable { let id: ItemID; let score: Float; let similarity: Float? }
struct SearchOutcome: Sendable { let hits: [Hit]; let timings: Timings; let degradedToKeyword: Bool }
struct Timings: Sendable { let embedMs: Double?; let scanMs: Double?; let rerankMs: Double?; let keywordMs: Double?; let n: Int; let dim: Int; let indexBytes: Int }

actor PufferIndex {
  static let shared = PufferIndex()

  /// Lazily opens the store and loads rows. Safe to call from a cold App Intent launch. Idempotent.
  func ready() async throws { fatalError("not implemented") }
  /// Bumps on every mutation. JS read models and the Spotlight mirror compare against it.
  var revision: Int { fatalError("not implemented") }

  func item(_ id: ItemID) -> ItemRecord? { fatalError("not implemented") }
  func items() -> [ItemRecord] { fatalError("not implemented") }
  func has(_ id: ItemID) -> Bool { fatalError("not implemented") }
  func add(_ item: ItemRecord, vec: [Float]) async throws { fatalError("not implemented") }
  func clear() async throws { fatalError("not implemented") }

  func search(_ request: SearchRequest) async throws -> SearchOutcome { fatalError("not implemented") }

  /// Members of a collection: hits for its saved query above the relevance cutoff, minus hidden ids.
  /// Cached per (collection query, revision). The only definition of membership in the codebase.
  func members(of collection: CollectionRecord) async throws -> Set<ItemID> { fatalError("not implemented") }
}
