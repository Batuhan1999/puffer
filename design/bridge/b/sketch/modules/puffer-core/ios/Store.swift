import Foundation
import SQLite3

// Durable state. One SQLite file, the one expo-sqlite already created at Documents/SQLite/puffer.db, so existing
// items and vectors survive the migration. `items` keeps its schema. New tables are added by `migrate`.
// Uses the system sqlite3 C API directly; no third-party dependency.

final class Store {
  private let db: OpaquePointer

  /// Opens or creates the database and runs `migrate`. WAL mode, like before.
  static func open(at url: URL) throws -> Store { fatalError("not implemented") }

  private init(db: OpaquePointer) { self.db = db }

  /// CREATE TABLE IF NOT EXISTS for:
  ///   items(id, kind, title, text, sourceUri, thumbName, addedAt, vec BLOB)          -- unchanged
  ///   collections(id PK, name, query, symbol)
  ///   collection_hidden(collectionId, itemId, PK(collectionId, itemId))
  ///   agents(id PK, name, role, symbol, createdAt, tokenHash)
  ///   grants(agentId, collectionId, PK(agentId, collectionId))
  ///   requests(id PK, agentId, question, receivedAt, proposal JSON, outcome JSON NULL, decidedAt NULL)
  ///   disclosures(requestId, agentId, itemId, kind, at)                              -- audit log of what left
  /// Seeds the six starter collections when `collections` is empty.
  func migrate() throws { fatalError("not implemented") }

  // Items. `vec` is read here and handed straight to Index; it never leaves this file and Index.swift.
  func allItems() throws -> [(Item, [Float])] { fatalError("not implemented") }
  func insertItem(_ item: Item, thumbName: String?, vec: [Float]) throws { fatalError("not implemented") }
  func deleteAllItems() throws { fatalError("not implemented") }

  func collections() throws -> [Collection] { fatalError("not implemented") }
  func upsertCollection(_ c: CollectionInput) throws { fatalError("not implemented") }
  func deleteCollection(_ id: CollectionId) throws { fatalError("not implemented") }
  func hide(_ item: ItemId, in collection: CollectionId) throws { fatalError("not implemented") }

  func agents() throws -> [Agent] { fatalError("not implemented") }
  func insertAgent(_ a: Agent, tokenHash: String) throws { fatalError("not implemented") }
  func deleteAgent(_ id: AgentId) throws { fatalError("not implemented") }
  func setGrant(_ agent: AgentId, _ collection: CollectionId, _ allowed: Bool) throws { fatalError("not implemented") }
  func tokenHashes() throws -> [(AgentId, String)] { fatalError("not implemented") }

  /// INSERT OR IGNORE keyed on request id, so redelivery is harmless.
  func insertRequest(_ r: IncomingRequest, proposal: Proposal) throws -> Bool { fatalError("not implemented") }
  func request(_ id: RequestId) throws -> (IncomingRequest, Proposal, Outcome?)? { fatalError("not implemented") }
  /// Writes outcome and disclosure rows in one transaction. Returns false if already decided.
  func decide(_ id: RequestId, _ outcome: Outcome) throws -> Bool { fatalError("not implemented") }
  func requests() throws -> [BridgeRequest] { fatalError("not implemented") }
}
