// modules/puffer-native/ios/Bridge.swift
// Owns policy (collections, agents, grants), the request ledger and the relay link.
// Single writer of bridge.db and of the Keychain item. Reads items only through Engine.

import Foundation
import UserNotifications

// MARK: policy

struct Collection: Codable, Sendable, Hashable {
  let id: CollectionID
  var name: String
  /// A saved description. Members are whatever canonical search ranks for it, minus `hidden`.
  var query: String
  var symbol: String
  var hidden: Set<ItemID>
}

/// "sha256:<hex>" of an agent key. The key itself exists only on the agent's side after connect.
struct KeyDigest: RawRepresentable, Codable, Sendable, Hashable { let rawValue: String }

struct Agent: Codable, Sendable, Hashable {
  let id: AgentID
  var name: String
  let keyDigest: KeyDigest
  var grants: Set<CollectionID>
  let connectedAt: Date
}

/// Returned once by `connectAgent`. Never persisted.
struct AgentCredential: Sendable {
  let agent: Agent
  /// "ak_" + 32 random bytes, base64url.
  let key: String
  /// `claude mcp add --transport http puffer <relay>/mcp --header "Authorization: Bearer <key>"`
  let setupCommand: String
}

/// Every policy write. Same action names as today's preview reducer, so the UI keeps its dispatch shape.
enum PolicyEdit: Codable, Sendable {
  case saveCollection(id: CollectionID, name: String, query: String, symbol: String)
  case removeCollection(CollectionID)              // also drops it from every agent's grants
  case hide(collection: CollectionID, item: ItemID)
  case grant(agent: AgentID, collection: CollectionID, allowed: Bool)
  case revokeAgent(AgentID)                        // pending requests from it become denied(.agentRevoked)
}

// MARK: ledger

enum Approver: String, Codable, Sendable { case user, grant }
enum DenialReason: String, Codable, Sendable { case user, expired, agentRevoked }

enum SharedImage: Codable, Sendable, Hashable {
  case pending(Data)   // JPEG, kept until the relay acks
  case sent            // bytes dropped after ack; the ledger still shows a photo left
}

/// What leaves the phone for one item. Built from ItemCard fields and an exported JPEG. No ids, no paths.
struct SharedItem: Codable, Sendable, Hashable {
  let title: String
  let kind: ItemKind
  let text: String?
  var image: SharedImage?
}

enum RequestPhase: Codable, Sendable {
  case received                                            // persisted, not yet triaged
  case awaitingUser(NonEmpty<Candidate>)
  case shared([SharedItem], by: Approver, at: Date)
  case nothingFound(at: Date)
  case denied(DenialReason, at: Date)

  var tag: PhaseTag { fatalError("not implemented") }
}

enum PhaseTag: String, Codable, Sendable { case received, awaitingUser, shared, nothingFound, denied }

struct LedgerEntry: Codable, Sendable {
  let id: RequestID
  let agentID: AgentID
  let question: String
  let receivedAt: Date
  let expiresAt: Date
  var phase: RequestPhase
  /// Last phase the relay acknowledged. The outbox is every entry with phase.tag != reported,
  /// excluding `.received`. Derived, so there is no outbox table to keep in step.
  var reported: PhaseTag?
}

enum UserDecision: Sendable {
  case share(Set<ItemID>)
  case deny
}

// MARK: relay link and presence

enum RelayStatus: Sendable {
  case unpaired
  case paired(url: URL, lastContact: Date?, lastError: String?)
}

/// Drives the sync loop. Set by SystemHooks from app lifecycle callbacks.
enum Presence: Sendable {
  case foreground                       // loop runs, long-polls back to back
  case grace(until: Date)               // loop runs inside beginBackgroundTask, stops at the deadline
  case suspended                        // no loop; only bounded `sync` calls from wakes
}

enum Topic: String, Sendable { case items, policy, requests, relay }

struct PolicySnapshot: Sendable {
  let relay: RelayStatus
  let collections: [Collection]
  let agents: [Agent]
  let requests: [LedgerEntry]           // newest first
}

actor Bridge {
  static let shared = Bridge()

  /// Opens bridge.db (seeding starter collections on first run), re-triages `.received` entries,
  /// expires entries past `expiresAt`. Idempotent.
  func start() async throws { fatalError("not implemented") }

  func snapshot() -> PolicySnapshot { fatalError("not implemented") }

  func edit(_ edit: PolicyEdit) throws { fatalError("not implemented") }

  /// Mints the agent id and key, stores only the digest, bumps the registry revision so the next
  /// sync pushes it, and returns the key once.
  func connectAgent(name: String) throws -> AgentCredential { fatalError("not implemented") }

  /// Stores the relay URL and device key in the Keychain (after-first-unlock), then syncs once.
  func pair(_ link: PairingLink) async throws { fatalError("not implemented") }

  func unpair() throws { fatalError("not implemented") }

  /// The single membership definition: Engine.search(.text(query), .canonical) minus hidden.
  /// Used by the collection screen and by triage.
  func members(_ id: CollectionID) async throws -> [ItemCard] { fatalError("not implemented") }

  /// Validates picks against the frozen candidates (Triage.approved), exports approved images,
  /// moves the phase, then kicks a sync. A second decision on a settled entry is a no-op.
  func decide(_ id: RequestID, _ decision: UserDecision) async throws { fatalError("not implemented") }

  /// Starts, stretches or stops the long-poll loop. Called from SystemHooks only.
  func setPresence(_ presence: Presence) { fatalError("not implemented") }

  /// One bounded exchange: post the derived outbox and registry, receive requests, persist them as
  /// `.received`, triage, and repeat while the outbox is non-empty and the deadline allows.
  /// Posts a local notification for new `.awaitingUser` entries unless presence is `.foreground`.
  func sync(_ wake: WakeSource, deadline: Date) async -> SyncReport { fatalError("not implemented") }

  /// Persist first, then triage, so a crash between the two leaves a `.received` entry that
  /// `start()` re-triages. Duplicate ids from relay re-delivery are ignored.
  private func receive(_ requests: [WireRequest]) async { fatalError("not implemented") }

  /// Runs canonical search and membership, applies Triage.decide, writes the next phase.
  /// If the model cannot load (for example in a memory-starved background wake), the entry stays
  /// `.received`. Consent never falls back to keyword ranking.
  private func triage(_ entry: LedgerEntry) async { fatalError("not implemented") }

  nonisolated var changes: AsyncStream<Topic> { fatalError("not implemented") }
}
