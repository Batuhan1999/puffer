// modules/puffer-native/ios/Engine.swift
// Owns items, vectors, the model and ranking. Single writer of puffer.db.
// Replaces src/library.ts, src/puffer.ts and the prompt half of src/model.ts.

import Accelerate
import CoreSpotlight
import Foundation
import SQLite3

enum SearchMode: String, Codable, Sendable { case vector, keyword, hybrid }
enum Dim: Int, Codable, Sendable, CaseIterable { case d128 = 128, d256 = 256, d512 = 512, d768 = 768 }

struct SearchOptions: Codable, Sendable, Equatable {
  var mode: SearchMode
  var dim: Dim
  var rerank: Bool
  /// The policy setting. Consent, collection membership, intents and the bridge use only this.
  /// UI prefs never reach a consent decision.
  static let canonical = SearchOptions(mode: .hybrid, dim: .d768, rerank: true)
}

enum SearchQuery: Sendable {
  case text(String)
  case like(ItemID)
}

struct Timings: Codable, Sendable {
  var embedMs: Double?
  var scanMs: Double?
  var rerankMs: Double?
  var keywordMs: Double?
  var n: Int
  var dim: Int
  var indexBytes: Int
}

struct Hit: Sendable {
  let card: ItemCard
  let score: Float
  let similarity: Float?
}

struct SearchResult: Sendable {
  let hits: [Hit]
  let timings: Timings
}

enum ModelPhase: Sendable {
  case absent
  case loading
  case ready(backend: String, loadMs: Double)
  case failed(String)
}

struct EngineStatus: Sendable {
  let model: ModelPhase
  let items: Int
  let photos: Int
  let passages: Int
  let revision: Int
}

struct NewPassage: Sendable {
  let id: ItemID
  let title: String
  let text: String
  let sourceUri: String
  let addedAt: Date
}

struct NewImage: Sendable {
  let id: ItemID
  let title: String
  let sourceUri: String
  let addedAt: Date
  /// 768 px JPEG made by JS ingest. Engine embeds it and deletes nothing; the caller owns the temp file.
  let embedJpeg: URL
  /// File name under Documents/thumbs, already written by JS ingest.
  let thumbName: String
}

actor Engine {
  static let shared = Engine()

  /// Documents/<model file>. Exposed to JS as a module constant so the download target and the load path are one value.
  static let modelURL: URL = { fatalError("not implemented") }()

  private var store: ItemStore?
  private var index = VectorIndex()
  private var keywords = Bm25()
  private var cards: [ItemCard] = []          // row-aligned with `index`
  private var rows: [ItemID: Int] = [:]
  private var embedder = Embedder()
  private var loading: Task<EngineStatus, Error>?
  private(set) var revision = 0               // bumped on every committed add or clear
  private let spotlight = SpotlightIndex()

  /// Idempotent. Concurrent callers (JS boot, an intent, a background wake) await the same task.
  /// Opens the store, loads rows into the index, loads the model if the file exists, reconciles Spotlight.
  func start() async throws -> EngineStatus { fatalError("not implemented") }

  func status() -> EngineStatus { fatalError("not implemented") }

  /// The one ranker. Port of src/puffer.ts `search`: MRL-truncated scan, optional 768d rerank,
  /// BM25 boost of 0.1, relative cutoff of 0.1 with at least 3 hits, at most 50 candidates.
  /// `.text` with a non-keyword mode and no model throws `PufferError.modelMissing`.
  func search(_ query: SearchQuery, _ options: SearchOptions) async throws -> SearchResult { fatalError("not implemented") }

  func cards(_ ids: [ItemID]) -> [ItemCard] { fatalError("not implemented") }

  func recent(limit: Int) -> [ItemCard] { fatalError("not implemented") }

  /// Embeds with the passage prompt, writes rows in one transaction, then updates the index and Spotlight.
  /// Ids already present are skipped, so a re-run after a crash converges.
  func addPassages(_ batch: [NewPassage]) async throws -> Int { fatalError("not implemented") }

  func addImage(_ image: NewImage) async throws { fatalError("not implemented") }

  func clear() async throws { fatalError("not implemented") }

  /// A JPEG of an item for an approved share: photo assets through PhotoKit, folder images through the
  /// folder store, at most 1024 px. Called only by Bridge.decide for ids the user switched on.
  func exportImage(_ id: ItemID) async throws -> Data { fatalError("not implemented") }
}

// MARK: internal storage, never public

/// SQLite over the existing `items` table plus `meta(key, value)`. Schema of items unchanged, so the
/// rows JS wrote with expo-sqlite load as they are.
struct ItemStore {
  init(url: URL) throws { fatalError("not implemented") }
  func loadAll(_ each: (ItemCard, UnsafeBufferPointer<Float>) -> Void) throws { fatalError("not implemented") }
  func insert(_ rows: [(ItemCard, sourceUri: String, thumbName: String?, vector: [Float])]) throws { fatalError("not implemented") }
  func deleteAll() throws { fatalError("not implemented") }
  func meta(_ key: String) throws -> Int? { fatalError("not implemented") }
  func setMeta(_ key: String, _ value: Int) throws { fatalError("not implemented") }
}

/// N x 768 row-major Float32, grown by doubling. Truncated, renormalized views per Dim, rebuilt lazily.
struct VectorIndex {
  mutating func append(_ vector: UnsafeBufferPointer<Float>) { fatalError("not implemented") }
  mutating func removeAll() { fatalError("not implemented") }
  /// cblas_sgemv over the view for `dim`.
  mutating func topK(_ query: [Float], dim: Dim, k: Int) -> [Scored] { fatalError("not implemented") }
  func similarity(_ query: [Float], row: Int) -> Float { fatalError("not implemented") }
  func vector(row: Int) -> [Float] { fatalError("not implemented") }
  func bytes(at dim: Dim) -> Int { fatalError("not implemented") }
}

struct Bm25 {
  mutating func add(row: Int, text: String) { fatalError("not implemented") }
  func search(_ text: String, k: Int) -> [Scored] { fatalError("not implemented") }
}

struct Scored: Sendable { let row: Int; let score: Float }

/// The existing EmbedRuntime from GemmaEmbedModule.swift, moved, plus the two prompts from src/model.ts.
struct Embedder {
  mutating func load(_ modelPath: String) async throws -> String { fatalError("not implemented") }
  func query(_ text: String) async throws -> [Float] { fatalError("not implemented") }            // "task: search result | query: {q}"
  func passages(_ items: [(title: String, text: String)]) async throws -> [[Float]] { fatalError("not implemented") }  // "title: {t} | text: {c}"
  func image(_ jpeg: URL) async throws -> [Float] { fatalError("not implemented") }
}

/// Classic Core Spotlight. Item id is the uniqueIdentifier; one domain, "items".
struct SpotlightIndex {
  func upsert(_ cards: [ItemCard]) async throws { fatalError("not implemented") }
  func removeAll() async throws { fatalError("not implemented") }
}

// MARK: pure ranking, ported line for line from src/puffer.ts

enum Ranking {
  static let candidates = 50
  static let keywordBoost: Float = 0.1
  static let relevanceWindow: Float = 0.1
  static let minHits = 3

  static func boosted(_ vector: [Scored], _ keyword: [Scored], similarity: (Int) -> Float) -> [Scored] { fatalError("not implemented") }
  static func relevant(_ hits: [Hit]) -> [Hit] { fatalError("not implemented") }
  static func truncate(_ vector: [Float], to dim: Dim) -> [Float] { fatalError("not implemented") }
  static func tokenize(_ text: String) -> [String] { fatalError("not implemented") }
}
