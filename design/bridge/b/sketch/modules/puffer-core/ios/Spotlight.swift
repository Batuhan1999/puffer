import CoreSpotlight
import ExpoModulesCore
import UniformTypeIdentifiers

// Spotlight mirror of the index. Plain CSSearchableItems (title, excerpt, thumbnail) under one domain, so the
// pod needs no knowledge of the AppEntity type that lives in the app target. Spotlight shows the item; tapping it
// continues an NSUserActivity of type CSSearchableItemActionType, which the subscriber below turns into
// `PufferEngine.openItem`. Intents in the app target may additionally `associateAppEntity` later; not needed now.

struct Spotlight {
  static let domain = "dev.local.puffer.items"

  /// Called by the engine after `addPassages` / `addPhoto` with the new items. Titles and a short excerpt only.
  func index(_ items: [Item]) async throws { fatalError("not implemented") }
  func removeAll() async throws { fatalError("not implemented") }

  private func attributes(for item: Item) -> CSSearchableItemAttributeSet { fatalError("not implemented") }
}

/// Registered through `expo-module.config.json` `apple.appDelegateSubscribers`. The subscriber manager forwards
/// `application(_:continue:restorationHandler:)` to subscribers (verified in ExpoAppDelegateSubscriberManager.swift).
public final class SpotlightContinuation: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([any UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    // guard userActivity.activityType == CSSearchableItemActionType,
    //       let raw = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return false }
    // Task { await PufferEngine.shared.openItem(ItemId(rawValue: raw)) }
    // return true
    fatalError("not implemented")
  }
}
