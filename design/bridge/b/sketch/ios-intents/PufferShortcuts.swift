import AppIntents

/// Zero-setup Siri phrases. Every phrase must include `\(.applicationName)`; at most 10 shortcuts per app (read:
/// Expo app-intents docs restating Apple's limits). Phrases are compiled in; nothing here is dynamic.
struct PufferShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: SearchPufferIntent(),
      phrases: [
        "Search \(.applicationName) for \(\.$query)",
        "Find \(\.$query) in \(.applicationName)",
        "Ask \(.applicationName) about \(\.$query)",
      ],
      shortTitle: "Search Puffer",
      systemImageName: "magnifyingglass"
    )
  }
}
