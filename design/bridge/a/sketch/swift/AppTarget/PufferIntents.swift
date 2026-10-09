// modules/puffer-native/app-target/PufferIntents.swift
// Compiled into the app target (not the pod) by the puffer-native config plugin, as a file reference
// to this path. Declarative only: entities, intents, shortcuts. Every call goes through `Puffer`.
// If the spike shows App Intents metadata is extracted from the static pod on Xcode 26, this file
// moves into the pod unchanged except for the import, and the plugin's Xcode step is deleted.

import AppIntents
import PufferNative

struct ItemEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Puffer Item"
  static let defaultQuery = ItemQuery()

  let id: String                                   // ItemID.rawValue; stays on device
  @Property(title: "Title") var title: String
  @Property(title: "Text") var text: String?
  @Property(title: "Added") var addedAt: Date
  let isPhoto: Bool
  let thumbnail: URL?

  var displayRepresentation: DisplayRepresentation { fatalError("not implemented") }
  init(_ card: ItemCard) { fatalError("not implemented") }
}

/// Lets other apps' actions take a Puffer result: plain text for passages, the thumbnail file for photos.
/// Belief: Shortcuts uses Transferable to hand entities to other actions on iOS 18.
extension ItemEntity: Transferable {
  static var transferRepresentation: some TransferRepresentation { ProxyRepresentation(exporting: \.plainText) }
  var plainText: String { fatalError("not implemented") }
}

struct ItemQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [ItemEntity] { fatalError("not implemented") }      // Puffer.cards
  func entities(matching string: String) async throws -> [ItemEntity] { fatalError("not implemented") }      // Puffer.search
  func suggestedEntities() async throws -> [ItemEntity] { fatalError("not implemented") }                    // Puffer.recent
}

struct CollectionEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Puffer Collection"
  static let defaultQuery = CollectionQuery()
  let id: String
  let name: String
  let symbol: String
  var displayRepresentation: DisplayRepresentation { fatalError("not implemented") }
}

struct CollectionQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [CollectionEntity] { fatalError("not implemented") }
  /// Also feeds App Shortcut phrase variants such as "Show my Receipts in Puffer".
  func suggestedEntities() async throws -> [CollectionEntity] { fatalError("not implemented") }              // Puffer.collections
}

struct SearchPufferIntent: AppIntent {
  static let title: LocalizedStringResource = "Search Puffer"
  static let description = IntentDescription("Finds photos and documents in Puffer by meaning. Runs on this iPhone.")
  /// Belief: available on iOS 18. A locked phone must not read personal snippets aloud.
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Query", requestValueDialog: "What should Puffer look for?") var query: String
  @Parameter(title: "Limit", default: 5) var limit: Int

  func perform() async throws -> some IntentResult & ReturnsValue<[ItemEntity]> & ProvidesDialog { fatalError("not implemented") }
}

struct ShowCollectionIntent: AppIntent {
  static let title: LocalizedStringResource = "Show Puffer Collection"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Collection") var collection: CollectionEntity
  func perform() async throws -> some IntentResult & ReturnsValue<[ItemEntity]> & ProvidesDialog { fatalError("not implemented") }   // Puffer.members
}

struct OpenItemIntent: OpenIntent {
  static let title: LocalizedStringResource = "Open in Puffer"
  @Parameter(title: "Item") var target: ItemEntity
  @MainActor func perform() async throws -> some IntentResult { fatalError("not implemented") }   // Puffer.open(.item)
}

/// For Shortcuts automations ("When charging", a time of day). Runs while Puffer is suspended or the
/// phone is locked: grant-covered requests are answered, the rest raise a local notification.
struct CheckAgentRequestsIntent: AppIntent {
  static let title: LocalizedStringResource = "Check Agent Requests"
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
  func perform() async throws -> some IntentResult & ProvidesDialog { fatalError("not implemented") }   // Puffer.syncAgentRequests(.intent)
}

struct PufferShortcuts: AppShortcutsProvider {
  /// Belief: App Shortcut phrases cannot embed a free-form String, so "Search Puffer" prompts for the query.
  static var appShortcuts: [AppShortcut] { fatalError("not implemented") }
  // AppShortcut(intent: SearchPufferIntent(), phrases: ["Search \(.applicationName)", "Ask \(.applicationName)"], ...)
  // AppShortcut(intent: ShowCollectionIntent(), phrases: ["Show my \(\.$collection) in \(.applicationName)"], ...)
  // AppShortcut(intent: CheckAgentRequestsIntent(), phrases: ["Check \(.applicationName) requests"], ...)
}
