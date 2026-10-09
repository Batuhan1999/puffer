import Foundation

// The one public facade of the pod. The Expo module, the App Intents in the app target, and the Spotlight
// subscriber all talk to `PufferEngine.shared` and nothing else. Everything else in this pod is `internal`.
//
// It is an actor because ingest (driven by JS), intents (driven by the system, possibly with JS cold), and
// bridge requests can all arrive at once. One writer path (ingest) and many readers; the actor serializes them.
// Loading the model and opening the store are lazy so an intent launched into a cold process pays only what it
// needs, inside the roughly 30 s intent budget.

public actor PufferEngine {
  public static let shared = PufferEngine()

  private var store: Store?
  private var index: Index?
  private let embedder = Embedder()
  private var spotlight = Spotlight()
  /// Set by the Expo module when JS is alive. Nil in a cold intent launch; `openItem` then parks the id.
  private var sink: EngineSink?
  private var pendingOpen: ItemId?

  private init() {}

  // MARK: Lifecycle

  public func attach(sink: EngineSink) { fatalError("not implemented") }
  public func detachSink() { fatalError("not implemented") }

  /// Idempotent. Opens `Documents/SQLite/puffer.db` (the file expo-sqlite already created, same schema plus new
  /// tables) and loads all rows into the in-memory index. Called by every public method on first use.
  private func ready() throws -> (Store, Index) { fatalError("not implemented") }

  public func load(modelPath: String) async throws -> Backend { fatalError("not implemented") }

  // MARK: Index

  public func addPassages(_ inputs: [PassageInput]) async throws -> Int { fatalError("not implemented") }
  public func addPhoto(_ input: PhotoInput) async throws -> Bool { fatalError("not implemented") }
  public func has(_ id: ItemId) -> Bool { fatalError("not implemented") }
  public func items() throws -> [Item] { fatalError("not implemented") }
  public func counts() -> [Kind: Int] { fatalError("not implemented") }
  public func clear() async throws { fatalError("not implemented") }
  public func search(_ query: Query, _ options: SearchOptions) async throws -> SearchResult { fatalError("not implemented") }

  // MARK: Collections

  public func collections() throws -> [Collection] { fatalError("not implemented") }
  public func saveCollection(_ c: CollectionInput) throws { fatalError("not implemented") }
  public func removeCollection(_ id: CollectionId) throws { fatalError("not implemented") }
  public func hide(_ item: ItemId, from collection: CollectionId) throws { fatalError("not implemented") }

  // MARK: Agents and grants

  public func agents() throws -> [Agent] { fatalError("not implemented") }
  /// Mints a 32-byte random secret. Stores only `sha256(secret)` and returns the secret once for display.
  public func createAgent(_ input: AgentInput) throws -> (agent: Agent, secret: String, tokenHash: String) { fatalError("not implemented") }
  public func removeAgent(_ id: AgentId) throws { fatalError("not implemented") }
  public func setGrant(agent: AgentId, collection: CollectionId, allowed: Bool) throws { fatalError("not implemented") }

  // MARK: Consent

  /// Idempotent on `request.id`: a repeated delivery of the same request returns the stored proposal.
  public func prepare(_ request: IncomingRequest) async throws -> Proposal { fatalError("not implemented") }
  /// Builds disclosures for `itemIds` (subset of the proposal's candidates), writes the disclosure log, returns the outcome.
  /// A second call for an already decided request returns the stored outcome without disclosing again.
  public func release(_ id: RequestId, itemIds: [ItemId]) throws -> Outcome { fatalError("not implemented") }
  public func deny(_ id: RequestId) throws -> Outcome { fatalError("not implemented") }
  public func requests() throws -> [BridgeRequest] { fatalError("not implemented") }

  // MARK: Navigation

  public func openItem(_ id: ItemId) { fatalError("not implemented") }
  public func takePendingOpen() -> ItemId? { fatalError("not implemented") }
}

/// What the engine needs from the Expo module: a way to tell JS something changed. Nothing else.
public protocol EngineSink: AnyObject, Sendable {
  func changed(_ tables: Set<Table>)
  func openItem(_ id: ItemId)
}

public enum Table: String, Sendable { case items, collections, agents, requests }
public enum Backend: String, Sendable { case gpu, cpu }
