// modules/puffer-native/ios/Puffer.swift
// The public surface of the PufferNative pod for code outside the module: the app-target App Intents.
// Everything else in the pod is `internal`. No public type can carry a vector.

import Foundation

public struct ItemID: RawRepresentable, Hashable, Codable, Sendable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
public struct CollectionID: RawRepresentable, Hashable, Codable, Sendable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
public struct AgentID: RawRepresentable, Hashable, Codable, Sendable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
/// Minted by the relay (`rq_<ulid>`). The phone never invents one.
public struct RequestID: RawRepresentable, Hashable, Codable, Sendable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }

public enum ItemKind: String, Codable, Sendable { case photo, passage }

/// The only item shape that leaves `Engine`. Built from a store row, never from the vector index.
public struct ItemCard: Hashable, Codable, Sendable {
  public let id: ItemID
  public let kind: ItemKind
  public let title: String
  /// Passage text, at most 800 characters (the ingest chunk size). nil for photos.
  public let snippet: String?
  public let addedAt: Date
  /// 256 px JPEG in Documents/thumbs. Local file URL, for Spotlight and entity display only.
  public let thumbnail: URL?
}

public struct CollectionCard: Hashable, Sendable {
  public let id: CollectionID
  public let name: String
  public let symbol: String
}

/// Why a sync is running. Sets the deadline and decides whether a local notification is posted.
public enum WakeSource: Sendable {
  case foreground          // long-poll loop while the app is active
  case backgroundGrace     // beginBackgroundTask window after the app leaves the foreground
  case appRefresh          // BGAppRefreshTask
  case intent              // CheckAgentRequestsIntent, usually run by a Shortcuts automation
}

public struct SyncReport: Sendable {
  public let reachedRelay: Bool
  public let received: Int
  public let answered: Int
  public let waitingForUser: Int
}

/// In-app destinations the system can open. One path for Spotlight taps, OpenItemIntent and notification taps.
public enum Route: Sendable {
  case item(ItemID)
  case request(RequestID)
}

public enum PufferError: Error, Sendable {
  case modelMissing        // the model file was never downloaded; the user must open the app once
  case notPaired           // no relay configured
}

public enum Puffer {
  /// Hybrid search with `SearchOptions.canonical`. Loads the store and model on first use (idempotent).
  public static func search(_ text: String, limit: Int) async throws -> [ItemCard] { fatalError("not implemented") }

  /// Resolves entity identifiers. Missing ids are dropped, not thrown.
  public static func cards(_ ids: [ItemID]) async throws -> [ItemCard] { fatalError("not implemented") }

  public static func recent(limit: Int) async throws -> [ItemCard] { fatalError("not implemented") }

  public static func collections() async -> [CollectionCard] { fatalError("not implemented") }

  /// The same membership the consent check uses: canonical search for the collection's query, minus hidden items.
  public static func members(_ id: CollectionID, limit: Int) async throws -> [ItemCard] { fatalError("not implemented") }

  /// One bounded sync with the relay. Never throws: an unreachable relay is a report, not an error.
  public static func syncAgentRequests(_ wake: WakeSource) async -> SyncReport { fatalError("not implemented") }

  /// Opens `puffer://...` for the route. Expo Router owns the screens.
  @MainActor public static func open(_ route: Route) { fatalError("not implemented") }
}
