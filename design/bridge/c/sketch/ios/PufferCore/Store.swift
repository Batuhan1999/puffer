import Foundation
import SQLite3

// The only code that touches puffer.db. Opens the file expo-sqlite already created (Documents/SQLite/puffer.db),
// so existing libraries survive the migration. JS never opens it again.
// WAL mode, one writer (this actor), file protection .completeUntilFirstUserAuthentication so a locked,
// previously unlocked phone can still answer.

typealias ItemID = String
typealias CollectionID = String
typealias AgentID = String
typealias RequestID = String

struct ItemRecord: Sendable {
  let id: ItemID
  let kind: ItemKind
  let title: String
  let text: String?
  let sourceUri: String
  let thumbName: String?
  let addedAt: Double
}
enum ItemKind: String, Sendable { case photo, passage }

struct CollectionRecord: Sendable {
  let id: CollectionID
  var name: String
  var query: String
  var symbol: String
  var hidden: Set<ItemID>
}

struct AgentRecord: Sendable {
  let id: AgentID
  var name: String
  var role: String
  var symbol: String
  var granted: Set<CollectionID>
  var revoked: Bool
}

actor Store {
  /// Creates the new tables beside `items`: collections, agents, grants, requests, settings. Additive, idempotent.
  static func open(at url: URL) throws -> Store { fatalError("not implemented") }

  func allItems() throws -> [(ItemRecord, [Float])] { fatalError("not implemented") }
  func insert(_ item: ItemRecord, vec: [Float]) throws { fatalError("not implemented") }   // INSERT OR IGNORE
  func deleteAllItems() throws { fatalError("not implemented") }

  func collections() throws -> [CollectionRecord] { fatalError("not implemented") }
  func save(_ collection: CollectionRecord) throws { fatalError("not implemented") }
  func removeCollection(_ id: CollectionID) throws { fatalError("not implemented") }       // also deletes its grants

  func agents() throws -> [AgentRecord] { fatalError("not implemented") }
  func save(_ agent: AgentRecord) throws { fatalError("not implemented") }

  func requests() throws -> [RequestRecord] { fatalError("not implemented") }
  func save(_ request: RequestRecord) throws { fatalError("not implemented") }

  func setting(_ key: String) throws -> String? { fatalError("not implemented") }
  func setSetting(_ key: String, _ value: String?) throws { fatalError("not implemented") }
}
