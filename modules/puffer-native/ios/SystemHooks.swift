import BackgroundTasks
import ExpoModulesCore
import os

let pufferLog = Logger(subsystem: "dev.local.puffer", category: "native")

enum BackgroundTask: String {
  case refresh
  case index

  var id: String {
    guard let id = Self.ids[rawValue] else {
      fatalError("PufferBackgroundTasks.\(rawValue) is missing from Info.plist. Run npx expo prebuild so the puffer-native plugin writes it.")
    }
    return id
  }

  private static let ids = Bundle.main.object(forInfoDictionaryKey: "PufferBackgroundTasks") as? [String: String] ?? [:]
}

/// Every imperative system hook, registered through expo-module.config.json "apple.appDelegateSubscribers",
/// so the app target stays declarative.
public class PufferAppDelegate: ExpoAppDelegateSubscriber {
  /// iOS grants about 30 s after backgrounding; the loop stops a little before that.
  static let graceMargin: TimeInterval = 5
  static let refreshInterval: TimeInterval = 15 * 60

  private var grace: UIBackgroundTaskIdentifier = .invalid

  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let refresh = BGTaskScheduler.shared.register(forTaskWithIdentifier: BackgroundTask.refresh.id, using: nil) { task in
      if let task = task as? BGAppRefreshTask { Self.handleRefresh(task) }
    }
    let index = BGTaskScheduler.shared.register(forTaskWithIdentifier: BackgroundTask.index.id, using: nil) { task in
      if let task = task as? BGProcessingTask { Self.handleIndex(task) }
    }
    pufferLog.notice("refresh task \(BackgroundTask.refresh.id, privacy: .public) registered: \(refresh)")
    pufferLog.notice("index task \(BackgroundTask.index.id, privacy: .public) registered: \(index)")
    return true
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    endGrace(application, suspend: false)
    Task {
      await Sources.shared.setForeground(true)
      await Bridge.shared.setPresence(.foreground)
      await Sources.shared.catchUp()
    }
  }

  /// Keeps the long-poll alive for the background window iOS grants, then lets the app suspend.
  public func applicationDidEnterBackground(_ application: UIApplication) {
    endGrace(application, suspend: false)
    let task = application.beginBackgroundTask(withName: "dev.local.puffer.grace") { [weak self] in
      self?.endGrace(application, suspend: true)
    }
    grace = task
    let window = max(0, min(application.backgroundTimeRemaining, 30) - Self.graceMargin)
    Task { await Bridge.shared.setPresence(.grace(until: Date().addingTimeInterval(window))) }
    DispatchQueue.main.asyncAfter(deadline: .now() + window) { [weak self] in
      if self?.grace == task { self?.endGrace(application, suspend: true) }
    }
    Self.scheduleRefresh()
    Task {
      await Sources.shared.setForeground(false)
      if await Sources.shared.behind { Self.scheduleIndex() }
    }
  }

  /// A file opened in Puffer from another app (Open In, the share sheet). Returning true keeps the URL away from
  /// React Native linking; puffer:// links return false and go there as before.
  public func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    guard url.isFileURL else { return false }
    Task { await ShareInbox.shared.receive([url]) }
    return true
  }

  /// `suspend` is false when the app is coming back to the foreground, which sets its own presence.
  private func endGrace(_ application: UIApplication, suspend: Bool) {
    guard grace != .invalid else { return }
    let task = grace
    grace = .invalid
    guard suspend else { return application.endBackgroundTask(task) }
    Task {
      await Bridge.shared.setPresence(.suspended)
      await Sources.shared.pause()
      await MainActor.run { application.endBackgroundTask(task) }
    }
  }

  /// Opportunistic: iOS decides when, and never for a force-quit app.
  private static func handleRefresh(_ task: BGAppRefreshTask) {
    scheduleRefresh()
    let work = Task {
      await Sources.shared.catchUp()
      _ = await Bridge.shared.sync(.appRefresh, deadline: Date().addingTimeInterval(25))
      task.setTaskCompleted(success: true)
    }
    task.expirationHandler = {
      work.cancel()
      Task { await Sources.shared.stop() }
    }
  }

  private static func scheduleRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: BackgroundTask.refresh.id)
    request.earliestBeginDate = Date().addingTimeInterval(refreshInterval)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      pufferLog.notice("refresh not scheduled: \(error.localizedDescription, privacy: .public)")
    }
  }

  private static func handleIndex(_ task: BGProcessingTask) {
    task.expirationHandler = { Task { await Sources.shared.stop() } }
    Task {
      let summary = await Sources.shared.catchUp()
      let behind = await Sources.shared.behind
      pufferLog.notice("index task: \(summary.files) files added, \(summary.failed) failed, behind: \(behind)")
      if behind { scheduleIndex() }
      task.setTaskCompleted(success: !behind)
    }
  }

  private static func scheduleIndex() {
    let request = BGProcessingTaskRequest(identifier: BackgroundTask.index.id)
    request.requiresExternalPower = true
    request.requiresNetworkConnectivity = false
    do {
      try BGTaskScheduler.shared.submit(request)
      pufferLog.notice("index task scheduled")
    } catch {
      pufferLog.notice("index task not scheduled: \(error.localizedDescription, privacy: .public)")
    }
  }
}
