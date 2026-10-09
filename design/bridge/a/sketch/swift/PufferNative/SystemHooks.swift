// modules/puffer-native/ios/SystemHooks.swift
// Every imperative system hook lives here, in the pod, registered through
// expo-module.config.json "apple.appDelegateSubscribers". The app target stays declarative.

import BackgroundTasks
import CoreSpotlight
import ExpoModulesCore
import UIKit
import UserNotifications

public class PufferAppDelegate: ExpoAppDelegateSubscriber, UNUserNotificationCenterDelegate {
  /// Read from Info.plist BGTaskSchedulerPermittedIdentifiers[0], which the config plugin writes from
  /// REFRESH_TASK_ID. One source; a missing key fails launch in debug builds.
  static let refreshTask: String = { fatalError("not implemented") }()

  /// Registers the BGAppRefreshTask handler (must happen before launch finishes) and the
  /// notification delegate. Does not load the model: the first caller of Engine.start() does.
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool { fatalError("not implemented") }

  /// Bridge.setPresence(.foreground). Starts the long-poll loop when paired.
  public func applicationDidBecomeActive(_ application: UIApplication) { fatalError("not implemented") }

  /// beginBackgroundTask, then Bridge.setPresence(.grace(until: now + backgroundTimeRemaining - 5 s)).
  /// The expiration handler sets .suspended and ends the task. Schedules the next refresh.
  public func applicationDidEnterBackground(_ application: UIApplication) { fatalError("not implemented") }

  /// Spotlight tap: CSSearchableItemActionType with the item id -> Puffer.open(.item(id)).
  /// Belief: ExpoAppDelegate forwards this to subscribers. The spike checks it.
  public func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool { fatalError("not implemented") }

  /// Notification tap on "<Agent> asks" -> Puffer.open(.request(id)).
  public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async { fatalError("not implemented") }

  /// BGAppRefreshTask: Bridge.sync(.appRefresh, deadline: now + 25 s), reschedule, complete.
  /// Opportunistic: iOS decides when, and never for a force-quit app (belief).
  private func handleRefresh(_ task: BGAppRefreshTask) { fatalError("not implemented") }

  private func scheduleRefresh() { fatalError("not implemented") }   // earliestBeginDate now + 15 min
}

/// Posts "<Agent> asks: “<question>”" for entries that enter .awaitingUser while not in the foreground.
/// Asks for notification permission the first time an agent is connected, not at launch.
struct Notifier {
  func requestAuthorizationIfNeeded() async { fatalError("not implemented") }
  func awaitingReview(_ entry: LedgerEntry, agentName: String) async { fatalError("not implemented") }
  func withdraw(_ id: RequestID) async { fatalError("not implemented") }   // once decided or expired
}
