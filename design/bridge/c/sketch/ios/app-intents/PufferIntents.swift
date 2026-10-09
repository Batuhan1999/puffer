import AppIntents
import PufferCore

// Copied into the app target by plugin/withPufferIntents.ts, because App Intents metadata is extracted from the target
// that declares them and a static CocoaPods pod may not qualify (unverified). The file is thin: every body calls
// SystemSearch in the pod. If a spike shows the pod qualifies through AppIntentsPackage (iOS 17+), the plugin shrinks to
// a three-line package file and this source moves into the pod.
//
// App Intents run in the app's own process. A Siri call cold-starts the process without React Native.
// The same PufferIndex.shared serves them, loaded from SQLite on first use.

struct PufferEntity: AppEntity, IndexedEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation { "Puffer Item" }
  static var defaultQuery = PufferEntityQuery()
  var id: String
  @Property(title: "Title") var title: String
  @Property(title: "Text") var snippet: String?
  var displayRepresentation: DisplayRepresentation { fatalError("not implemented") }
}

struct PufferEntityQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [PufferEntity] { fatalError("not implemented") }
  func entities(matching string: String) async throws -> [PufferEntity] { fatalError("not implemented") }
  func suggestedEntities() async throws -> [PufferEntity] { fatalError("not implemented") }
}

/// Shortcuts action. Free text in, entities out, so other apps and shortcuts can chain on the result.
struct SearchPufferIntent: AppIntent {
  static var title: LocalizedStringResource = "Search Puffer"
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
  static var openAppWhenRun = false
  @Parameter(title: "Search For", requestValueDialog: "What should I look for?") var query: String
  func perform() async throws -> some IntentResult & ReturnsValue<[PufferEntity]> & ProvidesDialog { fatalError("not implemented") }
}

/// Spoken path. The phrase interpolates an entity parameter (belief: phrases accept only AppEntity/AppEnum tokens, verify),
/// so Siri hands the spoken words to PufferEntityQuery.entities(matching:).
struct OpenPufferItemIntent: OpenIntent {
  static var title: LocalizedStringResource = "Open in Puffer"
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
  @Parameter(title: "Item") var target: PufferEntity
  func perform() async throws -> some IntentResult { fatalError("not implemented") }   // opens puffer://item/<id>
}

struct PufferShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] { fatalError("not implemented") }
  // "Search \(.applicationName) for \(\.$target)"  -> OpenPufferItemIntent
  // "Search \(.applicationName)"                    -> SearchPufferIntent (asks for the text)
}
