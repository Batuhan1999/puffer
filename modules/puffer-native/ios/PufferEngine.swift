import Foundation

enum Dim: Int, Sendable, CaseIterable { case d128 = 128, d256 = 256, d512 = 512, d768 = 768 }

/// Optional narrowing an agent can send with a question. Applied before ranking, so the floor and the window see only
/// admitted items.
struct SearchFilters: Codable, Sendable, Hashable {
  enum Kind: String, Codable, Sendable { case document, note }
  var kind: Kind?
  /// Inclusive. Files by last modified, notes by last edit; an item without metadata by when it was added.
  var after: Date?
  /// Exclusive.
  var before: Date?
  /// A source's display name: a folder's name, Shared with Puffer, or Notes. Case-insensitive.
  var source: String?

  var isEmpty: Bool { kind == nil && after == nil && before == nil && source == nil }

  func admits(_ item: StoredItem) -> Bool {
    if let kind {
      let wanted: ItemKind = switch kind {
      case .document: .passage
      case .note: .note
      }
      if item.card.kind != wanted { return false }
    }
    if after != nil || before != nil {
      let date = item.date
      if let after, date < after { return false }
      if let before, date >= before { return false }
    }
    if let source {
      let label = DocumentLabel.of(sourceUri: item.sourceUri, firstTitle: item.card.title).source
      if label.caseInsensitiveCompare(source) != .orderedSame { return false }
    }
    return true
  }
}

/// An item as PufferEngine holds it: the public card plus what only the phone needs.
struct StoredItem: Sendable {
  let card: ItemCard
  let sourceUri: String
  /// Milliseconds since 1970, exactly as stored.
  let addedAtMs: Int64
  /// nil until Sources read it.
  let metadata: ItemMetadata?
}

struct Hit: Sendable {
  let item: StoredItem
  let score: Double
  let similarity: Double?
  /// The item holds the query's words as typed (`Ranking.holds`), which passes the floor and the window.
  var literal = false
}

enum ModelPhase: Sendable {
  case absent
  case loading
  case ready(backend: String, loadMs: Double)
  case failed(String)
}

struct EngineStatus: Sendable {
  let model: ModelPhase
  let passages: Int
  let notes: Int
  let revision: Int
}

struct NewPassage: Sendable {
  let id: ItemID
  var kind: ItemKind = .passage
  let title: String
  let text: String
  let sourceUri: String
  let addedAtMs: Int64
}

/// One text document: its passages, and the items of its previous version that it replaces. The change log records
/// documents, not passages.
struct TextDocument: Sendable {
  let passages: [NewPassage]
  let metadata: ItemMetadata?
  let replacing: [ItemID]
}

enum ChangeKind: String, Codable, Sendable { case added, updated, removed }

/// How a change-log row finds its document now: by the source URI it was stored under, which survives edits that mint
/// new item ids. Rows logged before the column existed and never matched by the migration fall back to their item id.
/// On-device only: the source URI never goes on the wire.
enum DocumentKey: Hashable, Sendable {
  case source(String)
  case item(ItemID)
}

/// One change-log row. `seq` is monotonic and never reused (SQLite AUTOINCREMENT).
struct ChangeEvent: Sendable {
  let seq: Int64
  let at: Date
  let kind: ChangeKind
  /// The document's first item when the event was logged. It may no longer exist; `document` finds the current one.
  let itemID: ItemID
  let document: DocumentKey
  let itemKind: ItemKind
  let title: String
  /// Display name of where it came from: a folder name, Shared with Puffer, or Notes.
  let source: String
}

/// How the change log names a document. Derived from the source URI only, so added, updated and removed events
/// for one document carry the same title and source.
enum DocumentLabel {
  static let shared = "Shared with Puffer"
  static let notes = "Notes"

  static func of(sourceUri: String, firstTitle: String) -> (title: String, source: String) {
    if sourceUri.hasPrefix(NoteIndex.prefix) { return (firstTitle, notes) }
    if sourceUri.hasPrefix("folder:") {
      let rest = sourceUri.dropFirst("folder:".count)
      let folder = rest.prefix { $0 != "/" }
      return ((String(rest) as NSString).lastPathComponent, String(folder))
    }
    // Files imported through the document picker before Shared with Puffer existed: a cache file URL.
    return (URL(string: sourceUri)?.lastPathComponent ?? firstTitle, shared)
  }
}

actor PufferEngine {
  static let shared = PufferEngine()

  static let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  /// Prepared on first read rather than in a launch hook: the generated AppDelegate starts React Native before
  /// it calls subscribers' didFinishLaunching, so JS could look for the model before a hook had moved it.
  static let modelURL = ModelLocation.prepare()
  static let storeURL = documents.appendingPathComponent("SQLite/puffer.db")

  private var store: ItemStore?
  private var index = VectorIndex()
  private var keywords = Bm25()
  private var items: [StoredItem] = []
  private var rows: [ItemID: Int] = [:]
  private var counts: [ItemKind: Int] = [:]
  private(set) var revision = 0

  let embedder = Embedder()
  private var model: ModelPhase = .absent
  private var loading: Task<Void, Never>?

  /// Idempotent. Concurrent callers (JS boot, an intent, a background wake) share one open and one model load.
  func start() async throws {
    try openStore()
    await loadModel()
  }

  /// Opens puffer.db and loads every row into the index once. Synchronous inside the actor, so concurrent
  /// callers cannot interleave a second open.
  func openStore() throws {
    if store == nil { try load() }
  }

  /// Loads the model when its file exists. A failed load is retried by the next call.
  func loadModel() async {
    if case .ready = model { return }
    // A Shortcut or background task may not use the GPU; the next foreground loads it (Sources.catchUp).
    if await AppPresence.inBackground {
      pufferLog.notice("model load deferred: app in background")
      return
    }
    if let loading { return await loading.value }
    guard FileManager.default.fileExists(atPath: Self.modelURL.path) else {
      model = .absent
      return
    }
    // A download from JS lands as a new file without the flag, and expo-file-system cannot set it.
    ModelLocation.excludeFromBackup(Self.modelURL)
    model = .loading
    let task = Task {
      let t0 = Date()
      do {
        let backend = try await self.embedder.load(Self.modelURL.path)
        self.finishLoad(.ready(backend: backend, loadMs: Date().timeIntervalSince(t0) * 1000))
      } catch {
        self.finishLoad(.failed(error.localizedDescription))
      }
    }
    loading = task
    await task.value
  }

  /// A ready model indexes the notes that waited for it.
  private func finishLoad(_ phase: ModelPhase) {
    model = phase
    loading = nil
    if case .ready = phase { Task { await NoteIndexer.shared.run() } }
  }

  func status() -> EngineStatus {
    EngineStatus(model: model, passages: counts[.passage] ?? 0, notes: counts[.note] ?? 0, revision: revision)
  }

  func items(_ ids: [ItemID]) -> [StoredItem] {
    ids.compactMap { rows[$0].map { items[$0] } }
  }

  /// The source URI an item was stored under, or nil when it is not stored.
  func sourceUri(of id: ItemID) -> String? { rows[id].map { items[$0].sourceUri } }

  /// Each live document's first stored item, in row order. A document is live while any of its items is stored.
  func currentCards(_ documents: Set<DocumentKey>) -> [DocumentKey: ItemCard] {
    var out: [DocumentKey: ItemCard] = [:]
    for item in items {
      let key = DocumentKey.source(item.sourceUri)
      if out[key] == nil, documents.contains(key) { out[key] = item.card }
    }
    for case let .item(id) in documents {
      if let row = rows[id] { out[.item(id)] = items[row].card }
    }
    return out
  }

  /// Stored items grouped by the file or note they came from, keyed by source URI, in row order.
  func documents() -> [String: [ItemID]] {
    var out: [String: [ItemID]] = [:]
    for item in items { out[item.sourceUri, default: []].append(item.card.id) }
    return out
  }

  /// Newest first.
  func recentChanges(limit: Int) throws -> [ChangeEvent] {
    try openStore()
    return try store?.changes(newestFirst: true, after: 0, limit: limit) ?? []
  }

  /// Oldest first, every retained event with a larger seq.
  func changes(after seq: Int64) throws -> [ChangeEvent] {
    try openStore()
    return try store?.changes(newestFirst: false, after: seq, limit: nil) ?? []
  }

  /// Each document's first stored item that `filters` admit, newest first by its own date. Recency listings rank by this.
  func newest(_ filters: SearchFilters) throws -> [StoredItem] {
    try openStore()
    var seen = Set<String>()
    return items.filter { filters.admits($0) && seen.insert($0.sourceUri).inserted }.sorted { $0.date > $1.date }
  }

  /// The one ranker: hybrid at 768 dimensions, vector similarity nudged by BM25, cut by `Ranking.relevant`. Float32
  /// rows, float64 dot products. `window: false` keeps every hit over the floor, for an ask sorted by date that wants
  /// every confident match rather than the ones closest to the best. A keyword candidate that holds the query as typed
  /// (an exact name, number or ID the embedding scores low) comes first and passes the cut.
  func search(_ text: String, filters: SearchFilters = SearchFilters(), window: Bool = true) async throws -> [Hit] {
    try openStore()
    let allowed: [Bool]? = filters.isEmpty ? nil : items.map(filters.admits)
    let q = try await embedQuery(text, .search)
    let vectorRanked = index.topK(q, dim: .d768, k: Ranking.candidates + 1, allowed: allowed)
    let keywordRanked = keywords.search(text, k: Ranking.candidates, allowed: allowed)
    let ranked = Ranking.boosted(vectorRanked, keywordRanked) { index.similarity(q, row: $0) }
    let literal = Set(keywordRanked.map(\.row).filter { Ranking.holds(items[$0].card, text) })
    let candidates = ranked.filter { literal.contains($0.row) } + ranked.filter { !literal.contains($0.row) }.prefix(Ranking.candidates)
    let hits = candidates.map { scored in
      Hit(item: items[scored.row], score: scored.score, similarity: index.similarity(q, row: scored.row), literal: literal.contains(scored.row))
    }
    return Ranking.relevant(hits, floor: Ranking.minConfidence, window: window)
  }

  /// Embeds text documents together, passages batched across documents, then writes them in one transaction with one
  /// change event each: `added`, or `updated` when it replaces items of a previous version, or `removed` for a document
  /// with no passages left. A document whose first passage is already stored is skipped, so a re-run after a crash
  /// converges and logs nothing twice. Returns how many documents changed.
  @discardableResult
  func putTexts(_ documents: [TextDocument]) async throws -> Int {
    try openStore()
    let fresh = documents.filter { document in
      guard let first = document.passages.first else { return !items(document.replacing).isEmpty }
      return rows[first.id] == nil
    }
    let passages = fresh.flatMap(\.passages)
    var vectors: [[Float]] = []
    for start in stride(from: 0, to: passages.count, by: Self.passageBatch) {
      let batch = passages[start ..< min(start + Self.passageBatch, passages.count)]
      vectors += try await embedder.embedTexts(batch.map {
        Prompt.passage(title: Prompt.passageTitle(sourceUri: $0.sourceUri, title: $0.title), text: $0.text)
      })
    }
    var offset = 0
    let writes = fresh.map { document -> DocumentWrite? in
      let inserted = zip(document.passages, vectors[offset ..< offset + document.passages.count]).map { passage, vector in
        ItemRow(
          id: passage.id.rawValue, kind: passage.kind, title: passage.title, text: passage.text, sourceUri: passage.sourceUri,
          addedAt: passage.addedAtMs, metadata: document.metadata, vector: vector)
      }
      offset += document.passages.count
      return write(insert: inserted, delete: document.replacing)
    }
    return try await apply(writes).count
  }

  /// Deletes many documents in one transaction, one `removed` event each. Returns how many were stored.
  @discardableResult
  func remove(documents: [[ItemID]]) async throws -> Int {
    try openStore()
    if documents.isEmpty { return 0 }
    return try await apply(documents.map { write(insert: [], delete: $0) }).count
  }

  /// Moves a document to a new source URI without touching its content, for example after a folder's display
  /// name changed. Not a change event.
  func relabel(from old: String, to new: String) throws {
    try openStore()
    guard old != new, let store else { return }
    try store.relabel(from: old, to: new)
    try reload(from: store)
  }

  /// Each document's metadata by source URI, from its first item. Documents without metadata are absent.
  func storedMetadata() -> [String: ItemMetadata] {
    var out: [String: ItemMetadata] = [:]
    for item in items where out[item.sourceUri] == nil {
      if let metadata = item.metadata { out[item.sourceUri] = metadata }
    }
    return out
  }

  /// Replaces whole documents' metadata, keyed by source URI. Not a change event: the content is the same.
  func setMetadata(_ bySource: [String: ItemMetadata]) throws {
    try openStore()
    guard let store, !bySource.isEmpty else { return }
    try store.setMetadata(bySource)
    try reload(from: store)
  }

  /// Re-embeds every passage once after `Prompt.passage` changed. Ids, rows and the change log stay as they are. A crash
  /// before the version is written re-embeds everything again, which converges.
  func reembedPassages() async throws {
    try openStore()
    guard let store, try store.meta(Self.passagePromptKey) != Prompt.passageVersion else { return }
    let passages = items
    for start in stride(from: 0, to: passages.count, by: Self.passageBatch) {
      let batch = passages[start ..< min(start + Self.passageBatch, passages.count)]
      let vectors = try await embedder.embedTexts(batch.map {
        Prompt.passage(title: Prompt.passageTitle(sourceUri: $0.sourceUri, title: $0.card.title), text: $0.card.snippet ?? "")
      })
      try store.setVectors(Array(zip(batch.map(\.card.id), vectors)))
    }
    try store.setMeta(Self.passagePromptKey, Prompt.passageVersion)
    try reload(from: store)
    pufferLog.notice("re-embedded \(passages.count) passages")
  }

  /// The document a shared passage belongs to: its passages in stored order, and its original file on demand. A note
  /// has no file; its text is its passages.
  func sourceDocument(_ id: ItemID) -> SourceDocument? {
    guard let row = rows[id] else { return nil }
    let uri = items[row].sourceUri
    let text = items.lazy.filter { $0.sourceUri == uri }.compactMap(\.card.snippet).joined(separator: "\n\n")
    return SourceDocument(key: uri, text: text, file: { await DocumentFiles.read(sourceUri: uri) })
  }

  // MARK: private

  private func embedQuery(_ text: String, _ task: QueryTask) async throws -> [Float] {
    await loadModel()
    switch model {
    case .ready: break
    case .absent: throw PufferError.modelMissing
    case let .failed(message): throw PufferError.modelFailed(message)
    case .loading: throw PufferError.modelFailed("still loading")
    }
    guard let vector = try await embedder.embedTexts([Prompt.query(text, task)], lane: .query).first else {
      throw PufferError.modelFailed("no embedding returned")
    }
    return vector
  }

  private func load() throws {
    let opened = try ItemStore(url: Self.storeURL)
    try opened.pruneChanges(before: Date().addingTimeInterval(-Self.changeRetention))
    try reload(from: opened)
    store = opened
  }

  /// Rebuilds the in-memory index from the store. The index is append-only, so a delete reloads it.
  private func reload(from store: ItemStore) throws {
    index = VectorIndex()
    keywords = Bm25()
    items = []
    rows = [:]
    counts = [:]
    try store.loadAll { append($0) }
    bump()
  }

  /// The change event names the document by its first new row, or for a removal by its first stored item.
  /// nil when there is nothing to write.
  private func write(insert: [ItemRow], delete: [ItemID]) -> DocumentWrite? {
    let subject: (id: ItemID, kind: ItemKind, title: String, sourceUri: String)
    if let row = insert.first {
      subject = (ItemID(rawValue: row.id), row.kind, row.title, row.sourceUri)
    } else if let item = items(delete).first {
      subject = (item.card.id, item.card.kind, item.card.title, item.sourceUri)
    } else {
      return nil
    }
    let label = DocumentLabel.of(sourceUri: subject.sourceUri, firstTitle: subject.title)
    return DocumentWrite(
      insert: insert, delete: delete, itemID: subject.id, itemKind: subject.kind, sourceUri: subject.sourceUri,
      title: label.title, source: label.source)
  }

  /// One transaction for the rows and their change events, then the in-memory index.
  private func apply(_ writes: [DocumentWrite?]) async throws -> [ChangeEvent] {
    guard let store else { throw PufferError.storeFailed("not open") }
    let writes = writes.compactMap { $0 }
    let deletes = !items(writes.flatMap(\.delete)).isEmpty
    let events = try store.apply(writes, at: Date())
    if events.isEmpty { return [] }
    if deletes {
      try reload(from: store)
    } else {
      writes.flatMap(\.insert).forEach(append)
      bump()
    }
    return events
  }

  private static let passagePromptKey = "passagePrompt"
  static let passageBatch = 8
  static let changeRetention: TimeInterval = 90 * 24 * 60 * 60

  private func append(_ row: ItemRow) {
    let id = ItemID(rawValue: row.id)
    if rows[id] != nil || row.vector.count < VectorIndex.width { return }
    let card = ItemCard(
      id: id, kind: row.kind, title: row.title, snippet: row.text, addedAt: Date(timeIntervalSince1970: Double(row.addedAt) / 1000))
    let position = items.count
    items.append(StoredItem(card: card, sourceUri: row.sourceUri, addedAtMs: row.addedAt, metadata: row.metadata))
    rows[id] = position
    counts[row.kind, default: 0] += 1
    index.append(row.vector)
    let content = "\(row.title) \(row.text ?? "")"
    keywords.add(row: position, text: row.metadata.map { "\(content) \($0.keywordLine)" } ?? content)
  }

  private func bump() {
    revision += 1
    Changes.post(.items)
  }
}

/// EmbeddingGemma's query tasks (model card). Documents keep one format, `Prompt.passage`, for both. Search uses
/// `search` for every query: on the demo library `question` moved scores by at most 0.02 either way and separated
/// full questions no better (src/dev/calibrate.ts), so only the calibration probe uses it.
enum QueryTask: String, Sendable, CaseIterable {
  case search
  case question
}

/// EmbeddingGemma prompts. The query and passage formats live together so they cannot drift apart.
enum Prompt {
  /// Bumped when `passage` changes; PufferEngine.reembedPassages re-embeds stored passages once.
  static let passageVersion = 2

  static func query(_ text: String, _ task: QueryTask) -> String {
    switch task {
    case .search: "task: search result | query: \(text)"
    case .question: "task: question answering | query: \(text)"
    }
  }

  static func passage(title: String, text: String) -> String { "title: \(title.isEmpty ? "none" : title) | text: \(text)" }

  /// The title a passage is embedded under: its folder inside the source, then its own title, so a folder's name also
  /// finds what is in it ("Taxes/2025/receipts.pdf p.2"). A file at the top of its source keeps its title.
  static func passageTitle(sourceUri: String, title: String) -> String {
    guard sourceUri.hasPrefix("folder:") else { return title }
    let folders = sourceUri.dropFirst("folder:".count).split(separator: "/", omittingEmptySubsequences: false).dropFirst().dropLast()
    return folders.isEmpty ? title : folders.joined(separator: "/") + "/" + title
  }
}

// MARK: storage

struct ItemRow {
  let id: String
  let kind: ItemKind
  let title: String
  let text: String?
  let sourceUri: String
  let addedAt: Int64
  let metadata: ItemMetadata?
  let vector: [Float]
}

/// Rows to insert and delete for one document, and how its change event names it.
struct DocumentWrite {
  let insert: [ItemRow]
  let delete: [ItemID]
  let itemID: ItemID
  let itemKind: ItemKind
  let sourceUri: String
  let title: String
  let source: String
}

/// SQLite over the existing `items` table, unchanged so rows written by the former expo-sqlite store load as they
/// are, plus the `changes` log. Written only through PufferEngine.
final class ItemStore {
  private let db: SQLiteDB

  init(url: URL) throws {
    db = try SQLiteDB(url: url, schema: """
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT,
        sourceUri TEXT NOT NULL,
        thumbName TEXT,
        addedAt INTEGER NOT NULL,
        vec BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        itemID TEXT NOT NULL,
        itemKind TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        sourceUri TEXT
      );
      """)
    try addDocumentColumn()
    try addMetadataColumn()
    try removePhotos()
  }

  private static let photosRemovedKey = "photosRemoved"

  /// Photos and image files are no longer indexed. Their rows, events and thumbnails go once.
  private func removePhotos() throws {
    guard try meta(Self.photosRemovedKey) == nil else { return }
    try db.exec("DELETE FROM items WHERE kind = 'photo'; DELETE FROM changes WHERE itemKind = 'photo';")
    try? FileManager.default.removeItem(at: PufferEngine.documents.appendingPathComponent("thumbs", isDirectory: true))
    try setMeta(Self.photosRemovedKey, 1)
  }

  /// Rows written before metadata existed keep null until Sources backfills them.
  private func addMetadataColumn() throws {
    var columns = Set<String>()
    try db.query("PRAGMA table_info(items)") { columns.insert($0.text(1) ?? "") }
    if !columns.contains("meta") { try db.exec("ALTER TABLE items ADD COLUMN meta TEXT;") }
  }

  private static func json(_ metadata: ItemMetadata?) -> String? {
    metadata.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) }
  }

  func setMetadata(_ bySource: [String: ItemMetadata]) throws {
    try db.transaction {
      for (sourceUri, metadata) in bySource {
        try db.query("UPDATE items SET meta = ? WHERE sourceUri = ?", [.text(Self.json(metadata)), .text(sourceUri)])
      }
    }
  }

  func setVectors(_ vectors: [(ItemID, [Float])]) throws {
    try db.transaction {
      for (id, vector) in vectors {
        let row = Array(vector.prefix(VectorIndex.width))
        try db.query("UPDATE items SET vec = ? WHERE id = ?", [.blob(row.withUnsafeBytes { Data($0) }), .text(id.rawValue)])
      }
    }
  }

  /// Logs written before the `sourceUri` column get it, best effort: rows whose item still exists from that item, the
  /// rest from the newest later row with the same title and source. Unmatched rows stay null and resolve by item id.
  private func addDocumentColumn() throws {
    var columns = Set<String>()
    try db.query("PRAGMA table_info(changes)") { columns.insert($0.text(1) ?? "") }
    if columns.contains("sourceUri") { return }
    try db.transaction {
      try db.exec("""
        ALTER TABLE changes ADD COLUMN sourceUri TEXT;
        UPDATE changes SET sourceUri = (SELECT items.sourceUri FROM items WHERE items.id = changes.itemID) WHERE sourceUri IS NULL;
        UPDATE changes SET sourceUri = (
          SELECT later.sourceUri FROM changes AS later
          WHERE later.title = changes.title AND later.source = changes.source AND later.sourceUri IS NOT NULL
          ORDER BY later.seq DESC LIMIT 1
        ) WHERE sourceUri IS NULL;
        """)
    }
  }

  /// Applies every write and its change event in one transaction. The event kind follows what the statements did,
  /// so a write whose rows are already in place logs nothing: inserted and deleted is `updated`, only inserted is
  /// `added`, only deleted is `removed`.
  func apply(_ writes: [DocumentWrite], at: Date) throws -> [ChangeEvent] {
    var events: [ChangeEvent] = []
    if writes.isEmpty { return events }
    let atMs = Int64((at.timeIntervalSince1970 * 1000).rounded())
    try db.transaction {
      for write in writes {
        var deleted = 0
        for id in write.delete {
          try db.query("DELETE FROM items WHERE id = ?", [.text(id.rawValue)])
          deleted += db.changes
        }
        var inserted = 0
        for row in write.insert {
          let vector = Array(row.vector.prefix(VectorIndex.width))
          try db.query(
            "INSERT OR IGNORE INTO items (id, kind, title, text, sourceUri, addedAt, vec, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [.text(row.id), .text(row.kind.rawValue), .text(row.title), .text(row.text), .text(row.sourceUri),
             .int(row.addedAt), .blob(vector.withUnsafeBytes { Data($0) }), .text(Self.json(row.metadata))])
          inserted += db.changes
        }
        let kind: ChangeKind
        switch (inserted > 0, deleted > 0) {
        case (true, true): kind = .updated
        case (true, false): kind = .added
        case (false, true): kind = .removed
        case (false, false): continue
        }
        try db.query(
          "INSERT INTO changes (at, kind, itemID, itemKind, title, source, sourceUri) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [.int(atMs), .text(kind.rawValue), .text(write.itemID.rawValue), .text(write.itemKind.rawValue), .text(write.title),
           .text(write.source), .text(write.sourceUri)])
        events.append(ChangeEvent(
          seq: db.lastInsertRowID, at: Date(timeIntervalSince1970: Double(atMs) / 1000), kind: kind, itemID: write.itemID,
          document: .source(write.sourceUri), itemKind: write.itemKind, title: write.title, source: write.source))
      }
    }
    return events
  }

  func relabel(from old: String, to new: String) throws {
    try db.transaction {
      // The metadata names the old source; Sources reads it again.
      try db.query("UPDATE items SET sourceUri = ?, meta = NULL WHERE sourceUri = ?", [.text(new), .text(old)])
      try db.query("UPDATE changes SET sourceUri = ? WHERE sourceUri = ?", [.text(new), .text(old)])
    }
  }

  func changes(newestFirst: Bool, after seq: Int64, limit: Int?) throws -> [ChangeEvent] {
    var out: [ChangeEvent] = []
    let order = newestFirst ? "DESC" : "ASC"
    try db.query(
      "SELECT seq, at, kind, itemID, itemKind, title, source, sourceUri FROM changes WHERE seq > ? ORDER BY seq \(order) LIMIT ?",
      [.int(seq), .int(Int64(limit ?? -1))]
    ) { row in
      guard let kind = ChangeKind(rawValue: row.text(2) ?? ""), let itemKind = ItemKind(rawValue: row.text(4) ?? "") else { return }
      let itemID = ItemID(rawValue: row.text(3) ?? "")
      out.append(ChangeEvent(
        seq: row.int(0), at: Date(timeIntervalSince1970: Double(row.int(1)) / 1000), kind: kind, itemID: itemID,
        document: row.text(7).map(DocumentKey.source) ?? .item(itemID), itemKind: itemKind, title: row.text(5) ?? "",
        source: row.text(6) ?? ""))
    }
    return out
  }

  func pruneChanges(before date: Date) throws {
    try db.query("DELETE FROM changes WHERE at < ?", [.int(Int64(date.timeIntervalSince1970 * 1000))])
  }

  func meta(_ key: String) throws -> Int? {
    var value: Int?
    try db.query("SELECT value FROM meta WHERE key = ?", [.text(key)]) { value = Int($0.int(0)) }
    return value
  }

  func setMeta(_ key: String, _ value: Int) throws {
    try db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [.text(key), .int(Int64(value))])
  }

  func loadAll(_ each: (ItemRow) -> Void) throws {
    try db.query("SELECT id, kind, title, text, sourceUri, addedAt, vec, meta FROM items ORDER BY rowid") { row in
      guard let kind = ItemKind(rawValue: row.text(1) ?? "") else { return }
      let bytes = row.blob(6)
      var vector = [Float](repeating: 0, count: bytes.count / MemoryLayout<Float>.size)
      if bytes.baseAddress != nil {
        vector.withUnsafeMutableBytes { $0.copyMemory(from: UnsafeRawBufferPointer(rebasing: bytes.prefix($0.count))) }
      }
      each(ItemRow(
        id: row.text(0) ?? "", kind: kind, title: row.text(2) ?? "", text: row.text(3), sourceUri: row.text(4) ?? "",
        addedAt: row.int(5),
        metadata: row.text(7).flatMap { try? JSONDecoder().decode(ItemMetadata.self, from: Data($0.utf8)) }, vector: vector))
    }
  }

}

// MARK: index and ranking

struct Scored: Sendable {
  let row: Int
  let score: Double
}

/// N x 768 row-major Float32. Truncated, renormalized views per Dim are built lazily and dropped on append.
struct VectorIndex {
  static let width = 768
  private var full: [Float] = []
  private var views: [Dim: [Float]] = [:]
  private var count = 0

  mutating func append(_ vector: [Float]) {
    full.append(contentsOf: vector.prefix(Self.width))
    count += 1
    views.removeAll()
  }

  func vector(row: Int) -> [Float] { Array(full[row * Self.width ..< (row + 1) * Self.width]) }

  /// Builds the view for `dim` outside the timed scan.
  mutating func prepare(_ dim: Dim) {
    if dim == .d768 || views[dim] != nil { return }
    var out = [Float](repeating: 0, count: count * dim.rawValue)
    for row in 0 ..< count {
      let truncated = Ranking.truncate(full[row * Self.width ..< row * Self.width + dim.rawValue])
      out.replaceSubrange(row * dim.rawValue ..< (row + 1) * dim.rawValue, with: truncated)
    }
    views[dim] = out
  }

  /// The 768d view is the stored rows as they are; only the query is renormalized, as before.
  /// `allowed`, when given, has one entry per row; rows marked false are skipped.
  mutating func topK(_ query: [Float], dim: Dim, k: Int, allowed: [Bool]? = nil) -> [Scored] {
    prepare(dim)
    let width = dim.rawValue
    let q = Ranking.truncate(query[0 ..< width])
    return (dim == .d768 ? full : views[dim]!).withUnsafeBufferPointer { view in
      var best: [Scored] = []
      for row in 0 ..< count where allowed?[row] ?? true {
        var sum = 0.0
        let offset = row * width
        for j in 0 ..< width { sum += Double(view[offset + j]) * Double(q[j]) }
        Ranking.insertTop(&best, Scored(row: row, score: Double(Float(sum))), k: k)
      }
      return best
    }
  }

  func similarity(_ query: [Float], row: Int) -> Double {
    full.withUnsafeBufferPointer { rows in
      var sum = 0.0
      let offset = row * Self.width
      for j in 0 ..< Self.width { sum += Double(rows[offset + j]) * Double(query[j]) }
      return sum
    }
  }
}

extension StoredItem {
  /// The item's own date: last modified for a file or note, else when it was added. Date filters and recency use it.
  var date: Date { metadata?.date ?? card.addedAt }
}

enum Ranking {
  static let candidates = 50
  // Hybrid ranks by vector similarity and lets BM25 nudge, not decide.
  static let keywordBoost = 0.1
  // Cosine similarities from this model sit in a narrow band; hits far below the best one read as noise.
  static let relevanceWindow = 0.1

  // Absolute floor for text queries: no result beats a useless one. src/dev/calibrate.ts on the demo library, short
  // descriptions: text answers 0.705-0.842 against 0.619 at most for no answer, photos 0.700-0.779 against 0.658; 0.68
  // sits in both gaps. Full questions overlap (text 0.651 vs 0.653, photos 0.636 vs 0.654), so no floor serves them:
  // agents send short descriptions. Recalibrate on a real library.
  static let minConfidence = 0.68

  static func truncate(_ vector: ArraySlice<Float>) -> [Float] {
    var norm = 0.0
    for value in vector { norm += Double(value) * Double(value) }
    norm = norm.squareRoot()
    if norm == 0 { norm = 1 }
    return vector.map { Float(Double($0) / norm) }
  }

  /// Keeps `best` sorted descending with at most k entries; an equal score goes after the earlier row.
  static func insertTop(_ best: inout [Scored], _ scored: Scored, k: Int) {
    if best.count == k, scored.score <= best[k - 1].score { return }
    var at = best.count
    while at > 0, best[at - 1].score < scored.score { at -= 1 }
    best.insert(scored, at: at)
    if best.count > k { best.removeLast() }
  }

  static func sortedDescending(_ list: [Scored]) -> [Scored] {
    list.enumerated()
      .sorted { $0.element.score != $1.element.score ? $0.element.score > $1.element.score : $0.offset < $1.offset }
      .map(\.element)
  }

  static func boosted(_ vector: [Scored], _ keyword: [Scored], similarity: (Int) -> Double) -> [Scored] {
    let best = keyword.first.map(\.score).flatMap { $0 == 0 ? nil : $0 } ?? 1
    var normalized: [Int: Double] = [:]
    for scored in keyword { normalized[scored.row] = scored.score / best }
    var seen = Set<Int>()
    let rows = (vector + keyword).map(\.row).filter { seen.insert($0).inserted }
    return sortedDescending(rows.map { Scored(row: $0, score: similarity($0) + keywordBoost * (normalized[$0] ?? 0)) })
  }

  /// Every caller (note search, agents) gets the same cut. A literal hit always stays.
  static func relevant(_ hits: [Hit], floor: Double?, window: Bool = true) -> [Hit] {
    let kept = floor.map { floor in hits.filter { $0.literal || ($0.similarity ?? -1) >= floor } } ?? hits
    guard window else { return kept }
    guard let top = kept.map({ $0.similarity ?? -1 }).max() else { return [] }
    return kept.filter { $0.literal || ($0.similarity ?? -1) >= top - relevanceWindow }
  }

  /// The card's title or text holds `query` as typed, ignoring case and accents. Two characters at least.
  static func holds(_ card: ItemCard, _ query: String) -> Bool {
    let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard wanted.count > 1 else { return false }
    let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
    return card.title.range(of: wanted, options: options) != nil || card.snippet?.range(of: wanted, options: options) != nil
  }
}

/// Okapi BM25 over title and passage text. Terms are UTF-16 code-unit arrays so keys compare the way the
/// former JS Map did (no Unicode normalization).
struct Bm25 {
  private static let k1 = 1.2
  private static let b = 0.75
  private var postings: [[UInt16]: [(row: Int, tf: Int)]] = [:]
  private var lengths: [Int] = []
  private var totalLength = 0

  mutating func add(row: Int, text: String) {
    let terms = Self.tokenize(text)
    if lengths.count <= row { lengths.append(contentsOf: repeatElement(0, count: row + 1 - lengths.count)) }
    lengths[row] = terms.count
    totalLength += terms.count
    var tf: [[UInt16]: Int] = [:]
    var order: [[UInt16]] = []
    for term in terms {
      if tf[term] == nil { order.append(term) }
      tf[term, default: 0] += 1
    }
    for term in order { postings[term, default: []].append((row, tf[term]!)) }
  }

  func search(_ text: String, k: Int, allowed: [Bool]? = nil) -> [Scored] {
    let n = lengths.count
    if n == 0 { return [] }
    let average = Double(totalLength) / Double(n)
    let avg = average == 0 ? 1 : average
    var scores: [Int: Double] = [:]
    var order: [Int] = []
    var seen = Set<[UInt16]>()
    for term in Self.tokenize(text) where seen.insert(term).inserted {
      guard let posting = postings[term] else { continue }
      let df = Double(posting.count)
      let idf = log(1 + (Double(n - posting.count) + 0.5) / (df + 0.5))
      for (row, tf) in posting where allowed?[row] ?? true {
        let f = Double(tf)
        let norm = (f * (Self.k1 + 1)) / (f + Self.k1 * (1 - Self.b + (Self.b * Double(lengths[row])) / avg))
        if scores[row] == nil { order.append(row) }
        scores[row] = (scores[row] ?? 0) + idf * norm
      }
    }
    return Array(Ranking.sortedDescending(order.map { Scored(row: $0, score: scores[$0]!) }).prefix(k))
  }

  /// Lowercase, split on whitespace, ASCII punctuation, Latin-1 punctuation, general punctuation and CJK
  /// punctuation, drop one-unit tokens. The same classes as the former JS regex.
  static func tokenize(_ text: String) -> [[UInt16]] {
    var out: [[UInt16]] = []
    var current: [UInt16] = []
    for unit in text.lowercased().utf16 {
      if isSeparator(unit) {
        if current.count > 1 { out.append(current) }
        current.removeAll(keepingCapacity: true)
      } else {
        current.append(unit)
      }
    }
    if current.count > 1 { out.append(current) }
    return out
  }

  private static func isSeparator(_ u: UInt16) -> Bool {
    switch u {
    case 0x09 ... 0x0D, 0x20, 0x21 ... 0x2F, 0x3A ... 0x40, 0x5B ... 0x60, 0x7B ... 0x7E,
         0xA0 ... 0xBF, 0x1680, 0x2000 ... 0x200A, 0x2010 ... 0x206F, 0x3000 ... 0x303F, 0xFEFF:
      true
    default:
      false
    }
  }
}

// MARK: model

/// The model file and the XNNPACK caches LiteRT writes beside it (about 680 MB together) live in a directory
/// excluded from iCloud backup.
enum ModelLocation {
  static let name = "embeddinggemma-2-text-vision-440m.litertlm"

  static func prepare() -> URL {
    let files = FileManager.default
    let directory = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Model", isDirectory: true)
    try? files.createDirectory(at: directory, withIntermediateDirectories: true)
    excludeFromBackup(directory)
    moveOutOfDocuments(into: directory)
    return directory.appendingPathComponent(name)
  }

  private static func moveOutOfDocuments(into directory: URL) {
    let files = FileManager.default
    for old in (try? files.contentsOfDirectory(at: PufferEngine.documents, includingPropertiesForKeys: nil)) ?? [] where old.lastPathComponent.hasPrefix(name) {
      let new = directory.appendingPathComponent(old.lastPathComponent)
      do {
        if files.fileExists(atPath: new.path) { try files.removeItem(at: old) } else { try files.moveItem(at: old, to: new) }
        pufferLog.notice("model file \(old.lastPathComponent, privacy: .public) moved out of Documents")
      } catch {
        pufferLog.error("model file \(old.lastPathComponent, privacy: .public) not moved: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  static func excludeFromBackup(_ url: URL) {
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try url.setResourceValues(values)
    } catch {
      pufferLog.error("\(url.lastPathComponent, privacy: .public) not excluded from backup: \(error.localizedDescription, privacy: .public)")
    }
  }
}

/// The single LiteRT-LM embedding runtime in the process. One load, shared by every caller. The actor is reentrant
/// across awaits, so LiteRT calls take turns through `turn(_:)`: one at a time, queries ahead of queued indexing.
actor Embedder {
  enum Lane { case query, indexing }

  #if targetEnvironment(simulator)
  private static let backends: [Backend] = [.cpu()]
  #else
  private static let backends: [Backend] = [.gpu, .cpu()]
  #endif

  private var engine: EmbeddingEngine?
  private var loading: Task<(EmbeddingEngine, String), Error>?
  private var backend = ""
  private let options = EmbeddingOptions(normalize: true)
  private var busy = false
  /// Callers waiting for their turn: every query before every indexing call, each lane first come first served.
  private var waiting: [(lane: Lane, resume: CheckedContinuation<Void, Never>)] = []

  func load(_ modelPath: String) async throws -> String {
    if engine != nil { return backend }
    let task = loading ?? Task { try await Self.initialize(modelPath) }
    loading = task
    do {
      let (ready, name) = try await task.value
      engine = ready
      backend = name
      return name
    } catch {
      loading = nil
      throw error
    }
  }

  private static func initialize(_ modelPath: String) async throws -> (EmbeddingEngine, String) {
    var failure: Error = PufferError.modelFailed("No LiteRT backend available")
    for candidate in backends {
      let next = EmbeddingEngine(config: EmbeddingEngineConfig(modelPath: modelPath, backend: candidate, visionBackend: candidate))
      do {
        try await next.initialize()
        return (next, candidate.rawValue)
      } catch {
        pufferLog.error("LiteRT \(candidate.rawValue, privacy: .public) backend failed: \(error.localizedDescription, privacy: .public)")
        failure = error
      }
    }
    throw failure
  }

  func embedTexts(_ texts: [String], lane: Lane = .indexing) async throws -> [[Float]] {
    let engine = try loaded()
    await turn(lane)
    defer { endTurn() }
    do {
      return try await engine.computeEmbeddingBatch(contentsBatch: texts.map { [Content.text($0)] }, options: options).map(\.embedding)
    } catch {
      var out: [[Float]] = []
      for text in texts {
        out.append(try await engine.computeEmbedding(contents: [.text(text)], options: options).embedding)
      }
      return out
    }
  }

  private func turn(_ lane: Lane) async {
    if !busy {
      busy = true
      return
    }
    await withCheckedContinuation { resume in
      let firstIndexing = waiting.firstIndex(where: { $0.lane == .indexing }) ?? waiting.endIndex
      let at = lane == .query ? firstIndexing : waiting.endIndex
      waiting.insert((lane, resume), at: at)
    }
  }

  /// Hands the turn straight to the next waiter, so `busy` never drops in between.
  private func endTurn() {
    if waiting.isEmpty {
      busy = false
    } else {
      waiting.removeFirst().resume.resume()
    }
  }

  private func loaded() throws -> EmbeddingEngine {
    guard let engine else { throw PufferError.modelMissing }
    return engine
  }
}
