// modules/puffer-native/ios/Relay.swift
// The phone side of the wire. Codable mirrors of relay/src/protocol.ts (the authoritative schema).
// These types stay in this file: Bridge converts them to and from ledger types at the call site.

import Foundation
import Security

/// puffer://pair?relay=<url-encoded http(s) URL>&key=dk_<base64url>
struct PairingLink: Sendable {
  let relay: URL
  let deviceKey: String
  /// Rejects anything but http://localhost, http://127.0.0.1 and https URLs.
  static func parse(_ url: URL) -> PairingLink? { fatalError("not implemented") }
}

struct WireRequest: Codable, Sendable {
  let id: RequestID
  let agentId: AgentID
  let question: String
  let askedAt: Date
  let expiresAt: Date
}

struct WireSharedItem: Codable, Sendable {
  let title: String
  let kind: ItemKind
  let text: String?
  /// base64 JPEG, present only for photos the user switched on.
  let imageJpeg: String?
}

enum WireOutcome: Codable, Sendable {
  case answered(id: RequestID, items: [WireSharedItem])
  case nothingFound(id: RequestID)
  case declined(id: RequestID)
  case expired(id: RequestID)
  case awaitingUser(id: RequestID)
}

struct WireAgent: Codable, Sendable {
  let id: AgentID
  let name: String
  let keyDigest: KeyDigest
}

struct WireRegistry: Codable, Sendable {
  let revision: Int
  let agents: [WireAgent]
}

struct SyncBody: Codable, Sendable {
  let v: Int                       // 1
  let waitMs: Int
  let outbox: [WireOutcome]
  let registry: WireRegistry?      // sent while revision > last acked registryRevision
}

struct WireAck: Codable, Sendable {
  let id: RequestID
  let kind: String                 // matches the WireOutcome case name the relay stored
}

struct SyncResponse: Codable, Sendable {
  let v: Int
  let requests: [WireRequest]
  let acked: [WireAck]
  let registryRevision: Int
}

enum RelayFailure: Error, Sendable {
  case unreachable(String)
  case unauthorized                // device key rejected: the UI offers to pair again
  case incompatible(Int)           // 426, protocol version mismatch
}

struct RelayClient: Sendable {
  let base: URL
  let deviceKey: String

  /// POST /v1/device/sync. The URLSession timeout is waitMs + 10 s. Cancellation-aware.
  func sync(_ body: SyncBody) async throws(RelayFailure) -> SyncResponse { fatalError("not implemented") }
}

/// One generic-password item, service "dev.local.puffer.relay", accessible after first unlock so a
/// locked-phone wake can still sync.
enum RelayKeychain {
  static func save(_ link: PairingLink) throws { fatalError("not implemented") }
  static func load() -> PairingLink? { fatalError("not implemented") }
  static func delete() throws { fatalError("not implemented") }
}
