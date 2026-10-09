import AppIntents
import PufferCore

// App-target Swift. Copied into ios/<project>/Intents/ and linked to the app target by plugins/with-puffer-intents.js
// on every prebuild. App Intents metadata is extracted from the app target, so these types must be here and not
// in the pod. They are thin wrappers over PufferCore domain values.

struct PufferItemEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Puffer Item")
  static let defaultQuery = PufferItemQuery()

  let id: String
  let title: String
  let kind: String
  let excerpt: String?
  let thumbUri: String?

  var displayRepresentation: DisplayRepresentation { fatalError("not implemented") }

  init(_ item: Item, excerpt: String?) { fatalError("not implemented") }
}

/// Resolves ids the system saved in a shortcut, and free text typed into a parameter field. Both are engine calls.
struct PufferItemQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [PufferItemEntity] { fatalError("not implemented") }
  func entities(matching string: String) async throws -> [PufferItemEntity] { fatalError("not implemented") }
  func suggestedEntities() async throws -> [PufferItemEntity] { fatalError("not implemented") }
}

struct CollectionEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Collection")
  static let defaultQuery = CollectionQuery()
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation { fatalError("not implemented") }
}

struct CollectionQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [CollectionEntity] { fatalError("not implemented") }
  func suggestedEntities() async throws -> [CollectionEntity] { fatalError("not implemented") }
}
