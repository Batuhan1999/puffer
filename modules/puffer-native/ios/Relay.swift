import Foundation
import Security

// The phone side of the wire: Codable mirrors of relay/src/protocol.ts, the authoritative schema.
// These types stay in this file. Bridge converts them to and from ledger types.

/// puffer://pair?relay=<url-encoded http(s) URL>&key=dk_<base64url>
struct PairingLink: Codable, Sendable, Equatable {
  let relay: URL
  let deviceKey: String

  /// Accepts https relays, and plain http only on this device's loopback names.
  static func parse(_ url: URL) -> PairingLink? {
    guard url.scheme == "puffer", url.host == "pair",
          let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
          let relayText = items.first(where: { $0.name == "relay" })?.value, let relay = URL(string: relayText),
          let key = items.first(where: { $0.name == "key" })?.value, key.hasPrefix("dk_"), key.count > 10
    else { return nil }
    let loopback = ["localhost", "127.0.0.1"].contains(relay.host ?? "")
    guard relay.scheme == "https" || (relay.scheme == "http" && loopback) else { return nil }
    return PairingLink(relay: relay, deviceKey: key)
  }
}

struct WireRequest: Decodable, Sendable {
  enum Query: Sendable {
    /// `documents`: what of each document it asked for (include_documents). `newest`: the agent asked for sort recent,
    /// at most this many items.
    case ask(question: String, filters: SearchFilters?, documents: Extent, newest: Int?)
    /// list_puffer_recent: the newest items `filters` admit, without a question.
    case recent(filters: SearchFilters?, limit: Int, documents: Extent)
    /// `since` is the cursor the agent passed, as the agent sent it.
    case changes(since: String?, limit: Int)
    /// list_puffer_sources: source names and counts, no content.
    case sources
    case note(NoteRequest)
  }

  let id: RequestID
  let agentId: AgentID
  let query: Query
  let askedAt: Date
  let expiresAt: Date
  // Unverified (cloud): validate on the Mac
  /// Set on a note write the relay queued while this phone was offline (design/notes/CONTRACT.md section 3a).
  let queued: QueuedWrite?

  private enum Keys: String, CodingKey {
    case id, agentId, kind, question, broaden, filters, sort, includeDocuments, since, limit, askedAt, expiresAt
    case query, folder, noteId, title, body, text, baseVersion, queued, queuedAt
  }

  /// The relay validated the shape. A value this phone cannot read is dropped rather than failing the whole sync.
  private struct Filters: Decodable {
    let after: String?
    let before: String?
    let source: String?

    var parsed: SearchFilters? {
      let filters = SearchFilters(after: after.flatMap(Self.date), before: before.flatMap(Self.date), source: source)
      return filters.isEmpty ? nil : filters
    }

    /// YYYY-MM-DD is midnight UTC.
    private static func date(_ text: String) -> Date? {
      if let date = try? Date(text, strategy: .iso8601) { return date }
      return try? Date(text, strategy: Date.ISO8601FormatStyle().year().month().day())
    }
  }

  /// A request without `kind` is an ask, as every request was before changes requests existed.
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    id = try c.decode(RequestID.self, forKey: .id)
    agentId = try c.decode(AgentID.self, forKey: .agentId)
    askedAt = try c.decode(Date.self, forKey: .askedAt)
    expiresAt = try c.decode(Date.self, forKey: .expiresAt)
    let filters = (try? c.decodeIfPresent(Filters.self, forKey: .filters))?.parsed
    let documents = (try? c.decodeIfPresent(String.self, forKey: .includeDocuments)).flatMap(Extent.init(rawValue:)) ?? .excerpt
    // Unverified (cloud): validate on the Mac
    // `noteId` on a create is the id the relay minted for a queued create; on the other note kinds it names the note.
    let isQueued = (try? c.decodeIfPresent(Bool.self, forKey: .queued)) == true
    let queuedAt: Date? = isQueued ? ((try? c.decodeIfPresent(Date.self, forKey: .queuedAt)) ?? askedAt) : nil
    switch try c.decodeIfPresent(String.self, forKey: .kind) ?? "ask" {
    case "ask":
      let newest = (try? c.decodeIfPresent(String.self, forKey: .sort)) == "recent"
      query = .ask(
        question: try c.decode(String.self, forKey: .question), filters: filters, documents: documents,
        newest: newest ? try c.decode(Int.self, forKey: .limit) : nil)
    case "recent":
      query = .recent(filters: filters, limit: try c.decode(Int.self, forKey: .limit), documents: documents)
    case "changes":
      query = .changes(since: try c.decodeIfPresent(String.self, forKey: .since), limit: try c.decode(Int.self, forKey: .limit))
    case "sources":
      query = .sources
    case "searchNotes":
      query = .note(.search(
        query: try c.decode(String.self, forKey: .query), folder: try c.decodeIfPresent(String.self, forKey: .folder),
        recent: (try c.decodeIfPresent(String.self, forKey: .sort)) == "recent", limit: try c.decodeIfPresent(Int.self, forKey: .limit) ?? 10))
    case "listNotes":
      query = .note(.list(folder: try c.decodeIfPresent(String.self, forKey: .folder), limit: try c.decodeIfPresent(Int.self, forKey: .limit) ?? 20))
    case "listNoteFolders":
      query = .note(.folders)
    case "getNote":
      query = .note(.get(try c.decode(NoteID.self, forKey: .noteId)))
    case "createNote":
      query = .note(.create(
        title: try c.decodeIfPresent(String.self, forKey: .title), body: try c.decode(String.self, forKey: .body),
        folder: try c.decodeIfPresent(String.self, forKey: .folder)))
    case "appendToNote":
      query = .note(.append(try c.decode(NoteID.self, forKey: .noteId), text: try c.decode(String.self, forKey: .text)))
    case "updateNote":
      query = .note(.update(
        try c.decode(NoteID.self, forKey: .noteId), body: try c.decode(String.self, forKey: .body),
        baseVersion: try c.decode(Int.self, forKey: .baseVersion)))
    case "deleteNote":
      query = .note(.delete(try c.decode(NoteID.self, forKey: .noteId)))
    case let other:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown request kind \(other)")
    }
    // Unverified (cloud): validate on the Mac
    if let queuedAt, case let .note(note) = query, note.writes {
      var minted: NoteID?
      if case .create = note { minted = try? c.decodeIfPresent(NoteID.self, forKey: .noteId) }
      queued = QueuedWrite(at: queuedAt, noteID: minted)
    } else {
      queued = nil
    }
  }
}

struct WireSharedItem: Encodable, Sendable {
  let title: String
  /// Always "passage", which the relay still requires; a note goes as a passage.
  let kind = "passage"
  let text: String?
  /// The whole document, only when the agent asked for it.
  var document: WireDocument? = nil
  let date: Date?
  let folder: String?
  let fileType: String?
}

/// `WholeDocument` on the wire: {kind: text, text, truncated, fileMissing?} or {kind: file, name, mimeType, data}.
enum WireDocument: Encodable, Sendable {
  case text(String, truncated: Bool, fileMissing: FileMissing?)
  case file(name: String, mimeType: String, base64: String)

  /// nil once the bytes went.
  init?(_ document: WholeDocument) {
    switch document {
    case let .text(text, truncated, missing): self = .text(text, truncated: truncated, fileMissing: missing)
    case let .file(file): self = .file(name: file.name, mimeType: file.mimeType, base64: file.data.base64EncodedString())
    case .sent: return nil
    }
  }

  var bytes: Int {
    switch self {
    case let .text(text, _, _): text.utf8.count
    case let .file(_, _, base64): base64.utf8.count
    }
  }

  private enum Keys: String, CodingKey { case kind, text, truncated, fileMissing, name, mimeType, data }

  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    switch self {
    case let .text(text, truncated, missing):
      try c.encode("text", forKey: .kind)
      try c.encode(text, forKey: .text)
      try c.encode(truncated, forKey: .truncated)
      try c.encodeIfPresent(missing?.rawValue, forKey: .fileMissing)
    case let .file(name, mimeType, base64):
      try c.encode("file", forKey: .kind)
      try c.encode(name, forKey: .name)
      try c.encode(mimeType, forKey: .mimeType)
      try c.encode(base64, forKey: .data)
    }
  }
}

/// One page of the change log for one agent (Triage.changes).
struct WireChanges: Encodable, Sendable {
  let events: [ChangeNotice]
  let nextCursor: String
  /// Always 0: every agent sees every change. The relay still requires the field.
  let hiddenCount = 0
}

/// A source an agent may name, with how many documents it holds.
struct WireSource: Encodable, Sendable {
  let name: String
  let count: Int
}

/// The newest change-log seq an agent may see.
struct WireHead: Encodable, Sendable, Equatable {
  let agentId: AgentID
  let seq: Int64
}

/// The page a changes request since `since` would get now. The relay serves it, unchanged, while the phone sleeps.
struct WirePage: Encodable, Sendable {
  let agentId: AgentID
  let since: String?
  let page: WireChanges

  private enum Keys: String, CodingKey { case agentId, since, page }

  /// `since` is written as null rather than omitted: a page for an agent that never read is the no-cursor page.
  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Keys.self)
    try container.encode(agentId, forKey: .agentId)
    try container.encode(since, forKey: .since)
    try container.encode(page, forKey: .page)
  }
}

/// The next_cursor the relay last returned to an agent, from the phone's answer or from a page it served.
struct WireCursor: Decodable, Sendable {
  let agentId: AgentID
  let cursor: String
}

enum WireOutcome: Encodable, Sendable {
  case answered(id: RequestID, items: [WireSharedItem])
  /// Sent as an `answered` outcome with no items and a `changes` page.
  case changes(id: RequestID, WireChanges)
  /// Sent as an `answered` outcome with no items and `sources`.
  case sources(id: RequestID, [WireSource])
  /// Sent as an `answered` outcome with no items and one of `notes`, `folders` or `note`; a conflict as `conflict`.
  case note(id: RequestID, NoteResult)
  case nothingFound(id: RequestID)
  case declined(id: RequestID)
  case expired(id: RequestID)
  /// The phone could not check the request. `reason` is user-safe.
  case failed(id: RequestID, reason: String)

  var id: RequestID {
    switch self {
    case let .answered(id, _), let .changes(id, _), let .sources(id, _), let .note(id, _), let .nothingFound(id), let .declined(id),
         let .expired(id), let .failed(id, _): id
    }
  }

  /// Document bytes it carries, so one sync body stays under the relay's cap.
  var payloadBytes: Int {
    guard case let .answered(_, items) = self else { return 0 }
    return items.reduce(0) { $0 + ($1.document?.bytes ?? 0) }
  }

  /// The relay reads a missing `approvedBy` as `user` and tells the agent the user approved this one request.
  private static let approvedBy = "grant"

  var kind: String {
    switch self {
    case .note(_, .conflict): "conflict"
    case .answered, .changes, .sources, .note: "answered"
    case .nothingFound: "nothingFound"
    case .declined: "declined"
    case .expired: "expired"
    case .failed: "failed"
    }
  }

  private enum Keys: String, CodingKey {
    case kind, id, items, approvedBy, changes, sources, reason, notes, folders, note, currentVersion
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Keys.self)
    try container.encode(kind, forKey: .kind)
    try container.encode(id, forKey: .id)
    switch self {
    case let .answered(_, items):
      try container.encode(items, forKey: .items)
      try container.encode(Self.approvedBy, forKey: .approvedBy)
    case let .note(_, .conflict(currentVersion)):
      try container.encode(currentVersion, forKey: .currentVersion)
    case let .note(_, result):
      try container.encode([WireSharedItem](), forKey: .items)
      try container.encode(Self.approvedBy, forKey: .approvedBy)
      switch result {
      case let .notes(notes): try container.encode(notes, forKey: .notes)
      case let .folders(folders): try container.encode(folders, forKey: .folders)
      case let .note(note): try container.encode(note, forKey: .note)
      case .conflict: break
      }
    case let .changes(_, page):
      try container.encode([WireSharedItem](), forKey: .items)
      try container.encode(page, forKey: .changes)
    case let .sources(_, sources):
      try container.encode([WireSharedItem](), forKey: .items)
      try container.encode(sources, forKey: .sources)
    case let .failed(_, reason):
      try container.encode(reason, forKey: .reason)
    case .nothingFound, .declined, .expired:
      break
    }
  }
}

struct WireAgent: Encodable, Sendable {
  let id: AgentID
  let name: String
  let keyDigest: KeyDigest
}

struct WireRegistry: Encodable, Sendable {
  let revision: Int
  let agents: [WireAgent]
}

/// Where a connection request came from. Either way Puffer opens it through its approve link and presents the link's secret.
enum ConnectOrigin: Sendable, Equatable {
  /// An OAuth client, whose browser page shows the approve link as a QR code. `clientHost` is set only when the relay
  /// read the name from the client's metadata document there and the redirect is not loopback. The browser returns to
  /// `redirectHost` after approval.
  case oauth(clientHost: String?, redirectHost: String)
  /// An agent sent the user the approve link. Nothing verifies the name.
  case link
}

/// A request to connect through the relay. The relay holds its key; the phone sees only the digest.
/// Approving adds an agent with `keyDigest` to the registry, which is how the relay learns of it.
struct WireConnect: Decodable, Sendable, Equatable {
  let id: ConnectID
  /// Self-asserted unless an OAuth origin has a clientHost.
  let clientName: String
  let origin: ConnectOrigin
  let keyDigest: KeyDigest
  let requestedAt: Date
  let expiresAt: Date

  private enum Keys: String, CodingKey { case id, clientName, origin, clientHost, redirectHost, keyDigest, requestedAt, expiresAt }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    id = try c.decode(ConnectID.self, forKey: .id)
    clientName = try c.decode(String.self, forKey: .clientName)
    keyDigest = try c.decode(KeyDigest.self, forKey: .keyDigest)
    requestedAt = try c.decode(Date.self, forKey: .requestedAt)
    expiresAt = try c.decode(Date.self, forKey: .expiresAt)
    // A relay from before link connections sends no origin.
    switch try c.decodeIfPresent(String.self, forKey: .origin) ?? "oauth" {
    case "oauth":
      origin = .oauth(
        clientHost: try c.decodeIfPresent(String.self, forKey: .clientHost), redirectHost: try c.decode(String.self, forKey: .redirectHost))
    case "link": origin = .link
    case let other: throw DecodingError.dataCorruptedError(forKey: .origin, in: c, debugDescription: "unknown origin \(other)")
    }
  }
}

struct SyncBody: Encodable, Sendable {
  let v: Int
  let waitMs: Int
  let outbox: [WireOutcome]
  let registry: WireRegistry?
  /// Every agent's head, on every sync, so a restarted relay has them at once.
  let changeHeads: [WireHead]?
  /// A full replace of the relay's pages, always sent: an agent left out loses its page, which is how a page the phone
  /// cannot vouch for any more stops being served.
  let changePages: [WirePage]
  /// Repeated until a sync carrying them reaches the relay.
  let connectDeclines: [ConnectID]?
  /// Request kinds this phone reads. The relay keeps any other kind from it, since one unknown kind fails the whole sync.
  var requestKinds = RelayClient.requestKinds
}

struct WireAck: Decodable, Sendable {
  let id: RequestID
  let kind: String
}

/// A request this build cannot read keeps its id and agent, so it settles as failed instead of failing the whole sync.
enum IncomingRequest: Decodable, Sendable {
  case readable(WireRequest)
  /// Either is nil when not even that was readable.
  case unreadable(RequestID?, AgentID?)

  private enum Keys: String, CodingKey { case id, agentId }

  init(from decoder: Decoder) throws {
    do {
      self = .readable(try WireRequest(from: decoder))
    } catch {
      let c = try? decoder.container(keyedBy: Keys.self)
      let id = try? c?.decode(RequestID.self, forKey: .id)
      pufferLog.error("request \(id?.rawValue ?? "without id", privacy: .public) unreadable: \(error.localizedDescription, privacy: .public)")
      self = .unreadable(id, try? c?.decode(AgentID.self, forKey: .agentId))
    }
  }
}

struct SyncResponse: Decodable, Sendable {
  let v: Int
  let requests: [IncomingRequest]
  let acked: [WireAck]
  let registryRevision: Int
  /// The relay restarted and holds no snapshot yet; webhook settings live only in its memory.
  let wantsRegistry: Bool?
  let readCursors: [WireCursor]?
  /// Agents to remove: approved or confirmed connections that were never redeemed, and replayed authorization codes.
  /// nil from a relay before revocation.
  let revokedKeys: [KeyDigest]?
}

/// The relay's verdict on the link secret Puffer presented.
enum ConnectConfirmation: Decodable, Sendable, Equatable {
  case confirmed
  /// The secret does not match; the wire name predates link proofs.
  case wrongCode(attemptsLeft: Int)
  /// The third wrong secret ended the connection.
  case declined
  /// Unknown, expired or already ended.
  case gone

  private enum Keys: String, CodingKey { case status, attemptsLeft }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    switch try c.decode(String.self, forKey: .status) {
    case "confirmed": self = .confirmed
    case "wrongCode": self = .wrongCode(attemptsLeft: try c.decode(Int.self, forKey: .attemptsLeft))
    case "declined": self = .declined
    case "gone": self = .gone
    case let other: throw DecodingError.dataCorruptedError(forKey: .status, in: c, debugDescription: "unknown status \(other)")
    }
  }
}

private struct ConnectByLink: Decodable {
  let connect: WireConnect
}

private struct Registration: Decodable {
  let deviceKey: String
}

private struct ConfirmBody: Encodable {
  let v: Int
  let link: String
}

// Unverified (cloud): validate on the Mac
private struct VersionBody: Encodable {
  let v: Int
}

// Unverified (cloud): validate on the Mac
private struct Deleted: Decodable {
  let deleted: Bool
}

enum RelayFailure: Error, LocalizedError, Sendable {
  case unreachable(String)
  /// The device key was rejected: the user pairs again.
  case unauthorized
  case incompatible
  case rejected(Int, String)

  var errorDescription: String? {
    switch self {
    case let .unreachable(message): "Relay unreachable: \(message)"
    case .unauthorized: "The relay does not know this iPhone. Pair again."
    case .incompatible: "The relay speaks another protocol version."
    case let .rejected(status, message): "The relay answered \(status): \(message)"
    }
  }
}

struct RelayClient: Sendable {
  static let protocolVersion = 1
  static let longPollMs = 25_000
  static let requestKinds = [
    "ask", "recent", "changes", "sources", "searchNotes", "listNotes", "listNoteFolders", "getNote", "createNote", "appendToNote",
    "updateNote", "deleteNote",
  ]
  /// Where a new install registers itself when it has no pairing link.
  static let defaultRelay = URL(string: "https://puffer.fly.dev")!

  let link: PairingLink

  /// POST /v1/device/sync. The request times out 10 s after the long-poll budget. Cancellation-aware.
  func sync(_ body: SyncBody) async throws -> SyncResponse {
    try await post("v1/device/sync", body, timeout: Double(body.waitMs) / 1000 + 10)
  }

  /// POST /v1/device/connects/{id}/confirm with the secret of the approve link Puffer was opened with.
  func confirmConnect(_ id: ConnectID, linkSecret: String) async throws -> ConnectConfirmation {
    try await post("v1/device/connects/\(id.rawValue)/confirm", ConfirmBody(v: Self.protocolVersion, link: linkSecret), timeout: 15)
  }

  /// GET /v1/device/connects/by-link/{secret}: the connection an approve link opens. nil when the relay no longer has
  /// it waiting (404).
  func connect(byLink secret: String) async throws -> WireConnect? {
    do {
      let found: ConnectByLink = try await Self.send(Self.request(link.relay, "v1/device/connects/by-link/\(secret)", key: link.deviceKey, timeout: 15))
      return found.connect
    } catch RelayFailure.rejected(404, _) {
      return nil
    }
  }

  // Unverified (cloud): validate on the Mac
  /// POST /v1/device/rotate: a new device key for this device on the same relay. The old key stops working the moment
  /// the relay answers, so the caller stores the returned link before anything else uses the key.
  func rotateDeviceKey() async throws -> PairingLink {
    let rotated: Registration = try await post("v1/device/rotate", VersionBody(v: Self.protocolVersion), timeout: 15)
    return PairingLink(relay: link.relay, deviceKey: rotated.deviceKey)
  }

  // Unverified (cloud): validate on the Mac
  /// DELETE /v1/device: the relay deletes this device and everything it holds for it (agent keys, queued requests,
  /// webhooks). A 401 means the relay no longer knows the key, which is the same outcome.
  func deleteDevice() async throws {
    var request = Self.request(link.relay, "v1/device", key: link.deviceKey, timeout: 15)
    request.httpMethod = "DELETE"
    do {
      let _: Deleted = try await Self.send(request)
    } catch RelayFailure.unauthorized {
      return
    }
  }

  // Unverified (cloud): validate on the Mac
  /// POST /v1/device/register on `relay` with the signed-in account's session token as the bearer: a new tenant, owned
  /// by that account, and its device key. A 401 means the session is gone or expired: the user signs in again.
  static func register(_ relay: URL, session: String) async throws -> PairingLink {
    var post = Self.request(relay, "v1/device/register", key: session, timeout: 15)
    post.httpMethod = "POST"
    post.setValue("application/json", forHTTPHeaderField: "Content-Type")
    post.httpBody = Data(#"{"v":1}"#.utf8)
    let registered: Registration = try await Self.send(post)
    return PairingLink(relay: relay, deviceKey: registered.deviceKey)
  }

  private func post<Response: Decodable>(_ path: String, _ body: some Encodable, timeout: TimeInterval) async throws -> Response {
    var request = Self.request(link.relay, path, key: link.deviceKey, timeout: timeout)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    request.httpBody = try encoder.encode(body)
    return try await Self.send(request)
  }

  private static func request(_ relay: URL, _ path: String, key: String?, timeout: TimeInterval) -> URLRequest {
    var request = URLRequest(url: relay.appendingPathComponent(path))
    request.timeoutInterval = timeout
    if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
    return request
  }

  private static func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as URLError where error.code == .cancelled {
      // URLSession reports a cancelled task this way; the loop cancels its long-poll on every presence change.
      throw CancellationError()
    } catch {
      throw RelayFailure.unreachable(error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    switch status {
    case 200:
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .iso8601
      do {
        return try decoder.decode(Response.self, from: data)
      } catch {
        throw RelayFailure.rejected(status, "unreadable response: \(error.localizedDescription)")
      }
    case 401: throw RelayFailure.unauthorized
    case 426: throw RelayFailure.incompatible
    default: throw RelayFailure.rejected(status, String(decoding: data.prefix(300), as: UTF8.self))
    }
  }
}

/// Generic-password items readable after first unlock, so a locked-phone wake can still sync, and never restored to
/// another device.
enum Keychain {
  private static let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

  private static func query(_ service: String, _ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  static func save(_ data: Data, service: String, account: String) throws {
    try delete(service: service, account: account)
    var item = query(service, account)
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = accessible
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else { throw PufferError.storeFailed("Keychain save failed (\(status))") }
  }

  /// Moves an item saved under an older accessibility class to this one.
  static func load(service: String, account: String) -> Data? {
    var lookup = query(service, account)
    lookup[kSecReturnData as String] = true
    lookup[kSecReturnAttributes as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess, let found = result as? [String: Any],
          let data = found[kSecValueData as String] as? Data
    else { return nil }
    if found[kSecAttrAccessible as String] as? String != accessible as String {
      let status = SecItemUpdate(query(service, account) as CFDictionary, [kSecAttrAccessible as String: accessible] as CFDictionary)
      if status != errSecSuccess { pufferLog.error("keychain \(service, privacy: .public) not migrated: \(status)") }
    }
    return data
  }

  static func delete(service: String, account: String) throws {
    let status = SecItemDelete(query(service, account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw PufferError.storeFailed("Keychain delete failed (\(status))")
    }
  }
}

// Unverified (cloud): validate on the Mac
/// The relay account's session token (Better Auth), handed over by the JS client after sign-in. Used only to register.
enum RelaySessionKeychain {
  private static let service = "dev.local.puffer.relay"
  private static let account = "session"

  static func save(_ token: String) throws {
    try Keychain.save(Data(token.utf8), service: service, account: account)
  }

  static func load() -> String? {
    Keychain.load(service: service, account: account).map { String(decoding: $0, as: UTF8.self) }
  }

  static func delete() throws {
    try Keychain.delete(service: service, account: account)
  }
}

enum RelayKeychain {
  private static let service = "dev.local.puffer.relay"
  private static let account = "pairing"

  static func save(_ link: PairingLink) throws {
    try Keychain.save(try JSONEncoder().encode(link), service: service, account: account)
  }

  static func load() -> PairingLink? {
    Keychain.load(service: service, account: account).flatMap { try? JSONDecoder().decode(PairingLink.self, from: $0) }
  }

  static func delete() throws {
    try Keychain.delete(service: service, account: account)
  }
}
