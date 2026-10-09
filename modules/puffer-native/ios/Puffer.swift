import Foundation
import UIKit

public struct ItemID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

public struct AgentID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// Minted by the relay (`rq_<ulid>`). The phone never invents one.
public struct RequestID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// Minted by the relay (`cn_...`) for a client or agent waiting to connect.
public struct ConnectID: RawRepresentable, Hashable, Codable, Sendable {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
}

/// A passage of a document from a folder, or of a note. Both are text.
public enum ItemKind: String, Codable, Sendable { case passage, note }

/// The only item shape that leaves `PufferEngine`. Built from a store row, never from the vector index.
public struct ItemCard: Hashable, Codable, Sendable {
  public let id: ItemID
  public let kind: ItemKind
  public let title: String
  /// Passage text, at most 800 characters (the ingest chunk size).
  public let snippet: String?
  public let addedAt: Date
}

/// Why a sync is running. Sets how long it may wait.
public enum WakeSource: String, Sendable {
  /// Long-poll loop while the app is active.
  case foreground
  /// The window iOS grants after the app leaves the foreground.
  case backgroundGrace
  /// BGAppRefreshTask.
  case appRefresh
}

public struct SyncReport: Sendable {
  public let reachedRelay: Bool
  public let received: Int
  public let answered: Int
}

/// A note handed to Puffer by a Shortcut.
public struct NoteInput: Sendable {
  public let title: String
  public let text: String
  public let created: Date?
  /// nil means now.
  public let modified: Date?

  public init(title: String, text: String, created: Date?, modified: Date?) {
    self.title = title
    self.text = text
    self.created = created
    self.modified = modified
  }
}

/// iOS runs Puffer without UI for a Shortcut or a background task: no GPU work then, and little memory.
enum AppPresence {
  static var inBackground: Bool {
    get async { await MainActor.run { UIApplication.shared.applicationState == .background } }
  }
}

/// What changed, for listeners that refetch the slice they render.
enum Topic: String, Sendable { case items, policy, requests, relay, shared, notes }

enum Changes {
  static let notification = Notification.Name("dev.local.puffer.change")
  static func post(_ topic: Topic) {
    NotificationCenter.default.post(name: notification, object: nil, userInfo: ["topic": topic.rawValue])
  }
}

public enum PufferError: Error, LocalizedError, Sendable {
  case modelMissing
  case modelFailed(String)
  case storeFailed(String)

  public var errorDescription: String? {
    switch self {
    case .modelMissing: "The search model is not downloaded yet. Open Puffer once to download it."
    case let .modelFailed(message): "The search model could not load: \(message)"
    case let .storeFailed(message): "The library could not be read: \(message)"
    }
  }
}

/// The surface of the pod for the app-target App Intents.
public enum Puffer {
  /// Sync Notes to Puffer and Add to Puffer: converts what the Shortcut passed to Markdown notes, imports them and
  /// returns the dialog to show. They are saved at once, in `folder` (else Imported), and become searchable in the background.
  /// `extra` holds notes already built from the action's own fields.
  public static func importFromShortcut(_ inputs: [ShortcutInput], extra: [NoteInput] = [], source: String, folder: String?) async -> String {
    await ShortcutImport.run(inputs, extra: extra, source: source, folder: folder)
  }
}
