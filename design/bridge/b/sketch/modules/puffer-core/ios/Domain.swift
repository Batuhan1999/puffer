import Foundation

// Domain types. Public because the App Intents in the app target build entities from them.
// Vectors are not a domain type: `[Float]` appears only inside `Index` and `Embedder`.

public struct ItemId: Hashable, Sendable, Codable, RawRepresentable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
public struct AgentId: Hashable, Sendable, Codable, RawRepresentable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
public struct CollectionId: Hashable, Sendable, Codable, RawRepresentable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }
public struct RequestId: Hashable, Sendable, Codable, RawRepresentable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue } }

public enum Kind: String, Sendable, Codable { case photo, passage }
public enum Mode: String, Sendable, Codable { case vector, keyword, hybrid }
public enum Dim: Int, Sendable, Codable { case d128 = 128, d256 = 256, d512 = 512, d768 = 768 }

public struct Item: Sendable, Codable {
  public let id: ItemId
  public let kind: Kind
  public let title: String
  public let text: String?
  public let sourceUri: String
  public let thumbUri: String?
  public let addedAt: Double
}

public enum Query: Sendable {
  case text(String)
  case like(ItemId)
}

public struct SearchOptions: Sendable, Codable {
  public var mode: Mode
  public var dim: Dim
  public var rerank: Bool
}

public struct Hit: Sendable, Codable {
  public let item: Item
  public let score: Float
  public let similarity: Float?
}

public struct Timings: Sendable, Codable {
  public var embedMs, scanMs, rerankMs, keywordMs: Double?
  public var n: Int
  public var dim: Dim
  public var indexBytes: Int
}

public struct SearchResult: Sendable, Codable {
  public let hits: [Hit]
  public let timings: Timings
}

public struct PassageInput: Sendable, Codable { public let id: ItemId; public let title: String; public let text: String; public let sourceUri: String; public let addedAt: Double }
public struct PhotoInput: Sendable, Codable { public let id: ItemId; public let title: String; public let sourceUri: String; public let jpegUri: String; public let thumbName: String; public let addedAt: Double }

public struct Collection: Sendable, Codable {
  public let id: CollectionId
  public let name: String
  /// A collection is a saved description, not a folder. Membership is whatever the index ranks for `query`.
  public let query: String
  public let symbol: String
  public let hidden: [ItemId]
}
public struct CollectionInput: Sendable, Codable { public let id: CollectionId; public let name: String; public let query: String; public let symbol: String }

public struct Agent: Sendable, Codable {
  public let id: AgentId
  public let name: String
  public let role: String
  public let symbol: String
  public let createdAt: Double
  public let grants: [CollectionId]
}
public struct AgentInput: Sendable, Codable { public let name: String; public let role: String; public let symbol: String }

public struct IncomingRequest: Sendable, Codable {
  public let id: RequestId
  public let agentId: AgentId
  public let question: String
  public let receivedAt: Double
}

/// The only shapes that leave the phone. Mirrors `shared/bridge-protocol.ts` `Disclosure`.
public enum Disclosure: Sendable, Codable {
  case snippet(itemId: ItemId, title: String, excerpt: String, source: String)
  case image(itemId: ItemId, title: String, base64Jpeg: String)
}

public enum Outcome: Sendable, Codable {
  case released(disclosures: [Disclosure], auto: Bool, at: Double)
  case denied(at: Double)
  case nothing(at: Double)
  case expired(at: Double)
}

public struct Candidate: Sendable, Codable {
  public let item: Item
  public let rank: Int
  public let similarity: Float
  public let covered: [CollectionId]
  public let offered: Bool
  public let preview: Disclosure
}

public struct Proposal: Sendable, Codable {
  public let requestId: RequestId
  public let agentId: AgentId
  public let question: String
  public let candidates: [Candidate]
  public let auto: Bool
}

public struct BridgeRequest: Sendable, Codable {
  public let id: RequestId
  public let agentId: AgentId
  public let question: String
  public let receivedAt: Double
  public let status: Status
  public enum Status: Sendable, Codable { case pending; case decided(Outcome) }
}
