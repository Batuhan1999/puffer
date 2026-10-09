import AppIntents
import PufferCore

/// "Search Puffer for the lease deposit". Runs in the background: the system launches the app process without UI
/// if it is not running, and `PufferEngine.shared` lazily opens the store and loads the model (about 1.2 s on the
/// simulator). Returns entities so Shortcuts can chain them, plus a spoken dialog for Siri.
struct SearchPufferIntent: AppIntent {
  static let title: LocalizedStringResource = "Search Puffer"
  static let description = IntentDescription("Finds photos and passages in your Puffer library by meaning.")
  static var supportedModes: IntentModes { .background }
  // Personal data: the intent runs, but results are not shown on a locked device. (`authenticationPolicy` is a
  // belief from memory of the API; confirm the exact property name in Phase D before relying on it.)

  @Parameter(title: "Search for") var query: String
  @Parameter(title: "In collection") var collection: CollectionEntity?

  static var parameterSummary: some ParameterSummary {
    Summary("Search Puffer for \(\.$query)") { \.$collection }
  }

  func perform() async throws -> some IntentResult & ReturnsValue<[PufferItemEntity]> & ProvidesDialog {
    // let result = try await PufferEngine.shared.search(.text(query), prefs)
    // filter by collection membership when `collection` is set (same engine membership call Consent uses)
    // return .result(value: entities, dialog: "Found N items. The best match is …")
    fatalError("not implemented")
  }
}

/// Spotlight and Shortcuts "Open" action. Foreground by protocol (`OpenIntent`), then the engine's `openItem`
/// hands the id to JS (or parks it for a cold launch) and Expo Router shows the item.
struct OpenPufferItemIntent: OpenIntent {
  static let title: LocalizedStringResource = "Open Puffer Item"
  @Parameter(title: "Item") var target: PufferItemEntity

  func perform() async throws -> some IntentResult { fatalError("not implemented") }
}
