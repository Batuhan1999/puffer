import Foundation

// Relay session. Native owns it end to end so the enforcement path never depends on a live JS runtime.
//
// Lifecycle (honest version):
//  - Foreground: URLSessionWebSocketTask to the relay is connected, asks arrive, auto answers go out immediately,
//    reviewed asks wait in the Agents tab.
//  - Background or locked: iOS suspends the app within seconds. The socket dies. The relay flips presence to offline
//    and agents get `phone_offline`. A short beginBackgroundTask grace window flushes an in-flight answer, nothing more.
//  - Return to foreground: connect, `sync`, relay re-sends unanswered asks. Answers already given are re-sent from
//    the ledger. All steps are idempotent on requestId.
//  - Silent or alert push (needs a paid developer account, not part of the prototype): wake(payload) is the entry
//    point. The relay would send it on `queued` while presence is offline.

struct RelayEndpoint: Sendable {
  let url: URL
  /// Plain ws:// is accepted only for localhost, 127.0.0.1 and ::1. Everything else must be wss://.
  init(_ url: URL) throws { fatalError("not implemented") }
}

struct AskRecord: Sendable {
  let id: RequestID
  let agentId: AgentID
  let query: String
  let scope: AskScopeWire
  let receivedAt: Double
  let expiresAt: Double
}
enum AskScopeWire: String, Sendable { case granted, broaden }

/// Persisted lifecycle of one request on the phone. State machine, one writer (ConsentGate + Bridge).
enum RequestState: Sendable {
  case waitingForUser(offered: [ItemID], preselected: [ItemID])
  case answered(AnsweredRecord)
  case expired
}
struct AnsweredRecord: Sendable { let via: String?; let sharedItemIds: [ItemID]; let denied: Bool; let at: Double; let delivered: Bool }
struct RequestRecord: Sendable { let ask: AskRecord; var state: RequestState }

actor Bridge {
  static let shared = Bridge()

  func pair(endpoint: RelayEndpoint, code: String) async throws { fatalError("not implemented") }
  func connect() async { fatalError("not implemented") }
  func disconnect() async { fatalError("not implemented") }
  var connection: Connection { fatalError("not implemented") }
  enum Connection: Sendable { case unpaired, offline, connecting, online }

  /// Creates the agent row, registers its hash with the relay (signed), returns the credential for one-time display.
  func createAgent(name: String, role: String, symbol: String) async throws -> (AgentRecord, AgentCredential) { fatalError("not implemented") }
  func revokeAgent(_ id: AgentID) async throws { fatalError("not implemented") }

  func approve(_ id: RequestID, itemIds: [ItemID], imageIds: Set<ItemID>) async throws { fatalError("not implemented") }
  func deny(_ id: RequestID) async throws { fatalError("not implemented") }

  /// Push entry point. Not wired in the prototype.
  func wake() async { fatalError("not implemented") }
}
