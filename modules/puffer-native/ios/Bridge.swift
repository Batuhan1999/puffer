import CryptoKit
import Foundation

/// "sha256:<lowercase hex>" of an agent key, prefix included. The key itself exists only on the agent's side.
struct KeyDigest: RawRepresentable, Codable, Sendable, Hashable {
  let rawValue: String

  init(rawValue: String) { self.rawValue = rawValue }

  init(key: String) {
    rawValue = "sha256:" + SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

/// A connected agent. It reads and writes everything; the one approval was connecting it.
struct Agent: Codable, Sendable, Hashable {
  let id: AgentID
  var name: String
  let keyDigest: KeyDigest
  let connectedAt: Date
}

// MARK: ledger

enum DenialReason: String, Codable, Sendable { case user, expired, agentRevoked }

enum RequestPhase: Codable, Sendable {
  /// Persisted, not yet answered. A failed check is retried on a short schedule, then settles as `failed`.
  case received
  case shared(SharedPayload, at: Date)
  /// A note request ran.
  case note(NoteResult, at: Date)
  case nothingFound(at: Date)
  case denied(DenialReason, at: Date)
  /// The phone could not run the request. `reason` is shown to the user and sent to the agent.
  case failed(reason: String, at: Date)

  var tag: PhaseTag {
    switch self {
    case .received: .received
    case .shared, .note: .shared
    case .nothingFound: .nothingFound
    case .denied: .denied
    case .failed: .failed
    }
  }
}

enum PhaseTag: String, Codable, Sendable {
  case received, shared, nothingFound, denied, failed

  /// A tag this build does not know, such as `awaitingUser` in rows from when requests could wait for review, reads as
  /// not acknowledged: the phone sends the entry's outcome once more and the relay acknowledges it again.
  init(from decoder: Decoder) throws {
    self = PhaseTag(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .received
  }
}

/// Newest first by each item's own date (last modified) instead of by relevance.
enum Recency: Codable, Sendable, Hashable {
  /// ask_puffer with sort recent: every confident match for the question.
  case matches(limit: Int)
  /// list_puffer_recent: every item the filters admit. The entry's question only names the listing.
  case listing(limit: Int)

  var limit: Int {
    switch self {
    case let .matches(limit), let .listing(limit): limit
    }
  }
}

/// One agent request, kept for History.
struct LedgerEntry: Codable, Sendable {
  let id: RequestID
  let agentID: AgentID
  /// Kept so History still names an agent after it is disconnected.
  let agentName: String
  /// The question, or for a listing or a note request what it did.
  let question: String
  var filters: SearchFilters? = nil
  /// What of each document the agent asked for (include_documents). nil is the excerpt.
  var documents: Extent? = nil
  /// nil ranks by relevance.
  var recency: Recency? = nil
  var note: NoteRequest? = nil
  let receivedAt: Date
  let expiresAt: Date
  var phase: RequestPhase
  /// Last phase the relay acknowledged. The outbox is every entry whose phase differs from this.
  var reported: PhaseTag?
}

/// One get_puffer_changes read, kept for History. Reads are answered at once, so they are not ledger entries.
struct ChangeRead: Codable, Sendable {
  enum Outcome: Codable, Sendable {
    /// Answered by this phone.
    case answered(shown: Int)
    /// Served by the relay from the page this phone sent ahead, noticed when the agent's read cursor moved.
    case servedFromPage(shown: Int)
    /// Over the per-minute limit. The agent is told to try again in a minute.
    case rateLimited
  }

  /// The request id, or for a page the relay served, the agent and the cursor it moved to.
  let id: String
  let agentID: AgentID
  let agentName: String
  let at: Date
  let outcome: Outcome
}

enum BridgeError: Error, LocalizedError {
  case unknownAgent(String)
  case connectGone
  case wrongLink
  case tooManyWrongLinks
  case notPaired
  case noRandomness

  var errorDescription: String? {
    switch self {
    case let .unknownAgent(id): "No connected agent \(id)"
    case .connectGone: "This connection request is no longer waiting. Start again from the app that asked."
    case .wrongLink: "This link does not match the request. Open the link or scan the code again."
    case .tooManyWrongLinks: "Too many wrong links. Puffer declined this request."
    case .notPaired: "Puffer is not connected to a relay yet. Check the internet connection and try again."
    case .noRandomness: "This iPhone could not generate a secure key. Try again."
    }
  }
}

enum RelayStatus: Sendable {
  case unpaired
  case paired(url: URL, lastContact: Date?, lastError: String?)
}

/// Drives the sync loop. Set by SystemHooks from app lifecycle callbacks.
enum Presence: Sendable, Equatable {
  /// The loop long-polls back to back.
  case foreground
  /// The loop runs inside a background task and stops at the deadline.
  case grace(until: Date)
  /// No loop. Only bounded syncs from wakes.
  case suspended
}

struct BridgeSnapshot: Sendable {
  let relay: RelayStatus
  let agents: [Agent]
  /// Newest first.
  let requests: [LedgerEntry]
  /// Connection requests waiting for the user, oldest first.
  let connects: [WireConnect]
  /// Newest first.
  let reads: [ChangeRead]
}

/// An answer given at once without a ledger entry (a changes or sources read, or a request this build cannot read) until
/// the relay acknowledges it. Memory only: a lost answer is recomputed when the relay hands the request over again.
private struct ChangeAnswer {
  let outcome: WireOutcome
  let agentID: AgentID
  let agentName: String
  /// What History records once the relay takes it. nil for an agent this phone does not know, and for a sources read.
  let read: ChangeRead.Outcome?
}

/// Owns the agents, the request ledger and the relay link. Single writer of bridge.db. Reads items only through
/// PufferEngine and notes only through NoteBook.
actor Bridge {
  static let shared = Bridge()

  static let storeURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("bridge.db")
  /// Changes reads this phone answers per agent per minute; past it the read is declined.
  static let changeReadsPerMinute = 10
  static let readsKept = 200
  /// Settled entries the relay acknowledged that History keeps. Open and unacknowledged entries always stay.
  static let ledgerKept = 500
  static let reconnectNotice = "The relay no longer knew this iPhone, so Puffer registered again. Reconnect your agents."
  static let unreadableReason = "This version of Puffer cannot read this request. Update Puffer."
  /// Waits before each retry of a failed check. Once they are used up the request settles as failed.
  static let checkRetryDelays: [TimeInterval] = [2, 10, 30]
  static let checkTimeout: TimeInterval = 120
  private static let registeredKey = "puffer.registered"

  private var tables: (agents: DocumentTable, ledger: DocumentTable, meta: DocumentTable, reads: DocumentTable)?
  private var agents: [Agent] = []
  private var ledger: [RequestID: LedgerEntry] = [:]
  /// Oldest first, at most `readsKept`.
  private var reads: [ChangeRead] = []
  private var registryRevision = 0
  /// The registry revision the relay last confirmed. A newer local revision is pushed on the next sync.
  private var relayRegistryRevision = 0
  private var link: PairingLink?
  private var lastContact: Date?
  private var lastError: String?
  private var presence: Presence = .suspended
  private var loop: Task<Void, Never>?
  /// The loop's long-poll or its wait before retrying an unreachable relay. A kick cancels either to send at once.
  private var parkedPoll: Task<SyncResponse, Error>?
  private var nap: Task<Void, Never>?
  /// Counts kicks, so the loop does not park on an outbox computed before one.
  private var kicks = 0
  /// The one bounded sync a kick runs while there is no loop, and whether another kick came during it.
  private var kicked: Task<Void, Never>?
  private var kickAgain = false
  /// Set when the hosted relay forgot this iPhone and Puffer registered again; cleared by the next connected agent.
  private var reconnectAgents = false
  private var registering: Task<Void, Never>?
  private var changeAnswers: [RequestID: ChangeAnswer] = [:]
  /// The next_cursor the relay last returned to each agent. Pages are computed since it.
  private var readCursors: [AgentID: String] = [:]
  /// False until a response of this link arrived since launch: until then a cursor that differs is news to the phone,
  /// not a read.
  private var cursorsHeard = false
  /// The pages the last sync that reached the relay carried, which the relay now serves.
  private var pagesAtRelay: [AgentID: WirePage] = [:]
  private var noticesCache: Notices?
  /// What the last sync that reached the relay carried, so a bounded wake sends a page that moved before it ends.
  private var sentNotices: NoticesBasis?
  /// Connections fetched through the approve link Puffer was opened with.
  private var fetchedConnects: [ConnectID: WireConnect] = [:]
  /// Declines sent until a response shows the relay took them.
  private var declinedConnects: Set<ConnectID> = []
  /// Connections the user opened through their approve link, with the link's secret, which approval presents.
  private var openedLinks: [ConnectID: String] = [:]
  /// Checks running now, by start time. A check older than `checkTimeout` counts as stuck.
  private var checking: [RequestID: Date] = [:]
  /// Checks that failed and wait for their next attempt. Memory only: a relaunch starts the schedule over.
  private var checkRetries: [RequestID: CheckRetry] = [:]

  /// Opens bridge.db and expires stale requests. Idempotent and synchronous inside the actor.
  func start() throws {
    if tables != nil { return }
    let db = try SQLiteDB(url: Self.storeURL, schema: ["agents", "ledger", "meta", "reads"].map(DocumentTable.schema).joined())
    Self.protect(Self.storeURL)
    let opened = (
      agents: DocumentTable(db: db, name: "agents"), ledger: DocumentTable(db: db, name: "ledger"),
      meta: DocumentTable(db: db, name: "meta"), reads: DocumentTable(db: db, name: "reads"))
    let meta = Dictionary(try opened.meta.all(MetaValue.self).map { ($0.key, $0.value) }) { $1 }
    agents = try opened.agents.all(Agent.self)
    ledger = Dictionary(try opened.ledger.all(LedgerEntry.self).map { ($0.id, $0) }) { $1 }
    reads = try opened.reads.all(ChangeRead.self)
    registryRevision = meta["registryRevision"] ?? 0
    relayRegistryRevision = meta["relayRegistryRevision"] ?? 0
    reconnectAgents = meta["reconnectAgents"] == 1
    link = RelayKeychain.load()
    tables = opened
    expireStale()
    pruneLedger()
  }

  /// bridge.db holds ledger excerpts waiting to go out: kept out of backups, and readable from first unlock on so a
  /// background wake can still open it.
  private static func protect(_ url: URL) {
    for path in [url.path, url.path + "-wal", url.path + "-shm"] where FileManager.default.fileExists(atPath: path) {
      do {
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: path)
      } catch {
        pufferLog.error("\((path as NSString).lastPathComponent, privacy: .public) protection not set: \(error.localizedDescription, privacy: .public)")
      }
      ModelLocation.excludeFromBackup(URL(fileURLWithPath: path))
    }
  }

  func snapshot() throws -> BridgeSnapshot {
    try start()
    expireStale()
    let notice = lastError ?? (reconnectAgents ? Self.reconnectNotice : nil)
    return BridgeSnapshot(
      relay: link.map { .paired(url: $0.relay, lastContact: lastContact, lastError: notice) } ?? .unpaired,
      agents: agents, requests: ledger.values.sorted { $0.receivedAt > $1.receivedAt }, connects: pendingConnects(),
      reads: reads.reversed())
  }

  /// Open requests from the agent settle as denied(.agentRevoked); the relay drops its key on the next sync.
  func disconnect(_ agentID: AgentID) throws {
    try start()
    agents.removeAll { $0.id == agentID }
    try tables?.agents.delete(agentID.rawValue)
    for entry in ledger.values where entry.agentID == agentID && entry.phase.tag == .received {
      try setPhase(entry.id, .denied(.agentRevoked, at: Date()))
    }
    try bumpRegistry()
    Changes.post(.policy)
    kick()
  }

  /// Approving adds an agent with the relay-held key's digest, once the relay confirms the secret of the link Puffer was
  /// opened with. The registry snapshot carrying the agent is the approval: the relay issues the key only once it knows
  /// the digest. `keyDigest` is the one the screen showed, so a listing that changed under it does not count.
  func approveConnect(_ id: ConnectID, keyDigest: KeyDigest) async throws -> AgentID {
    try start()
    guard let link, let connect = pendingConnects().first(where: { $0.id == id && $0.keyDigest == keyDigest }),
          let secret = openedLinks[id]
    else { throw BridgeError.connectGone }
    switch try await RelayClient(link: link).confirmConnect(id, linkSecret: secret) {
    case .confirmed:
      // A second tap whose confirm also came back.
      if let known = agents.first(where: { $0.keyDigest == keyDigest }) { return known.id }
      guard self.link == link, pendingConnects().contains(where: { $0.id == id && $0.keyDigest == keyDigest }) else {
        throw BridgeError.connectGone
      }
      let agent = try register(name: connect.clientName, keyDigest: keyDigest)
      fetchedConnects[id] = nil
      return agent.id
    case .wrongCode:
      throw BridgeError.wrongLink
    case .declined:
      dropConnect(id)
      throw BridgeError.tooManyWrongLinks
    case .gone:
      dropConnect(id)
      throw BridgeError.connectGone
    }
  }

  private func dropConnect(_ id: ConnectID) {
    fetchedConnects[id] = nil
    Changes.post(.relay)
  }

  /// Puffer was opened through an approve link: fetch that connection from the relay and keep the secret approval
  /// presents. A failed fetch is retried after `connectFetchRetryDelays`, then thrown.
  func openConnectLink(_ id: ConnectID, secret: String) async throws {
    try start()
    openedLinks[id] = secret
    Changes.post(.relay)
    await ensureRegistered()
    guard let link else { throw BridgeError.notPaired }
    var delays = Self.connectFetchRetryDelays[...]
    while true {
      do {
        let found = try await RelayClient(link: link).connect(byLink: secret)
        guard self.link == link else { return }
        lastContact = Date()
        if let found, found.id == id { fetchedConnects[id] = found }
        Changes.post(.relay)
        return
      } catch let error as RelayFailure {
        guard case .unreachable = error, let delay = delays.popFirst() else { throw error }
        pufferLog.notice("connect \(id.rawValue, privacy: .public) not fetched, retrying: \(error.localizedDescription, privacy: .public)")
        try await Task.sleep(for: .seconds(delay))
      }
    }
  }

  static let connectFetchRetryDelays: [TimeInterval] = [1, 3]

  func declineConnect(_ id: ConnectID) throws {
    try start()
    guard pendingConnects().contains(where: { $0.id == id }) else { throw BridgeError.connectGone }
    declinedConnects.insert(id)
    fetchedConnects[id] = nil
    Changes.post(.relay)
    kick()
  }

  /// Persist first, then answer, so a crash between the two leaves a `.received` entry that `retriage()` picks up.
  /// Duplicate ids from relay re-delivery are ignored.
  @discardableResult
  private func receive(_ entries: [LedgerEntry]) throws -> [RequestID] {
    try start()
    var fresh: [RequestID] = []
    for entry in entries where ledger[entry.id] == nil {
      ledger[entry.id] = entry
      try tables?.ledger.put(entry.id.rawValue, entry, position: entry.receivedAt.timeIntervalSince1970)
      fresh.append(entry.id)
    }
    if !fresh.isEmpty { Changes.post(.requests) }
    return fresh
  }

  /// Answers every entry still `.received` whose retry is due, and fails a check that has been running too long.
  /// Runs at the start of every sync, so a foreground, a wake and each loop pass pick up what a failure left.
  func retriage() async {
    guard (try? start()) != nil else { return }
    let now = Date()
    for (id, started) in checking where now.timeIntervalSince(started) > Self.checkTimeout {
      fail(id, "Searching took too long.")
    }
    for entry in ledger.values where entry.phase.tag == .received {
      await triage(entry.id)
    }
  }

  // MARK: relay

  /// A new install with no pairing registers itself with the default relay, once. A user who unpaired is not
  /// registered again. Failures retry on the next foreground.
  func ensureRegistered() async {
    guard (try? start()) != nil, link == nil, !UserDefaults.standard.bool(forKey: Self.registeredKey) else { return }
    if let registering { return await registering.value }
    let task = Task {
      do {
        let registered = try await RelayClient.register(RelayClient.defaultRelay)
        guard self.link == nil else { return }
        try RelayKeychain.save(registered)
        UserDefaults.standard.set(true, forKey: Self.registeredKey)
        self.link = registered
        self.lastError = nil
        try self.setRelayRegistryRevision(0)
        pufferLog.notice("registered with \(registered.relay.absoluteString, privacy: .public)")
        Changes.post(.relay)
        self.restartLoop()
      } catch {
        pufferLog.error("registration failed: \(error.localizedDescription, privacy: .public)")
      }
    }
    registering = task
    await task.value
    registering = nil
  }

  /// Stores the relay URL and device key in the Keychain, forces a registry push and syncs once. A link other than the
  /// current one first forgets everything the old relay was told or asked; the same link again is not a reset.
  func pair(_ url: URL) async throws {
    try start()
    guard let parsed = PairingLink.parse(url) else {
      throw RelayFailure.rejected(0, "Not a Puffer pairing link. Open the link the relay printed.")
    }
    if parsed != link { try forgetRelay() }
    try RelayKeychain.save(parsed)
    UserDefaults.standard.set(true, forKey: Self.registeredKey)
    link = parsed
    lastError = nil
    try setRelayRegistryRevision(0)
    Changes.post(.relay)
    restartLoop()
    _ = await sync(.foreground, deadline: Date().addingTimeInterval(10))
  }

  func unpair() throws {
    try start()
    try RelayKeychain.delete()
    try forgetRelay()
    link = nil
    loop?.cancel()
    loop = nil
    Changes.post(.relay)
  }

  /// Drops what belongs to one relay: answers and connections it handed over, cursors and pages it holds. Its open
  /// requests settle as expired, and nothing it asked is sent to the next relay. Called before `link` changes, so an
  /// exchange in flight sees the change and discards its response.
  private func forgetRelay() throws {
    changeAnswers.removeAll()
    fetchedConnects.removeAll()
    declinedConnects.removeAll()
    openedLinks.removeAll()
    readCursors.removeAll()
    cursorsHeard = false
    pagesAtRelay.removeAll()
    noticesCache = nil
    sentNotices = nil
    lastContact = nil
    lastError = nil
    try setRelayRegistryRevision(0)
    let now = Date()
    for var entry in ledger.values where entry.phase.tag == .received || entry.phase.tag != entry.reported {
      if entry.phase.tag == .received { entry.phase = .denied(.expired, at: now) }
      entry.phase = Self.withoutBytes(entry.phase)
      entry.reported = entry.phase.tag
      ledger[entry.id] = entry
      try tables?.ledger.put(entry.id.rawValue, entry, position: entry.receivedAt.timeIntervalSince1970)
    }
    Changes.post(.requests)
  }

  /// A sources pass or a note write changed the library. Syncs now, so moved change heads reach the relay without
  /// waiting out the parked long-poll.
  func libraryChanged() {
    kick()
  }

  /// Starts, stretches or stops the long-poll loop. Called from SystemHooks only.
  func setPresence(_ next: Presence) {
    presence = next
    // On a cold launch the lifecycle hook can arrive before anything opened the bridge, and the loop needs `link`.
    try? start()
    restartLoop()
    if next == .foreground, link == nil { Task { await self.ensureRegistered() } }
  }

  /// One bounded exchange cycle: post the derived outbox and registry, receive requests, answer them, and repeat while
  /// there is something to send and the deadline allows. Never throws: an unreachable relay is a report, not an error.
  func sync(_ wake: WakeSource, deadline: Date) async -> SyncReport {
    await retriage()
    guard (try? start()) != nil, let link else {
      return SyncReport(reachedRelay: false, received: 0, answered: 0)
    }
    let client = RelayClient(link: link)
    var reached = false
    var received = 0
    var answered = 0
    while !Task.isCancelled {
      let kicksSeen = kicks
      let outbox = self.outbox()
      let registry = registryRevision > relayRegistryRevision ? wireRegistry() : nil
      let notices = await self.notices()
      let declines = declinedConnects.sorted { $0.rawValue < $1.rawValue }
      let remainingMs = Int(deadline.timeIntervalSinceNow * 1000) - 5_000
      // The relay takes heads and pages before it parks, so they ride on the long-poll.
      let longPoll = wake == .foreground && outbox.isEmpty && registry == nil && declines.isEmpty && kicks == kicksSeen
      let waitMs = longPoll ? max(0, min(RelayClient.longPollMs, remainingMs)) : 0
      let call = exchange(client, SyncBody(
        v: RelayClient.protocolVersion, waitMs: waitMs, outbox: outbox, registry: registry,
        changeHeads: notices.heads, changePages: notices.pages, connectDeclines: declines.isEmpty ? nil : declines))
      let response: SyncResponse
      do {
        response = try await withTaskCancellationHandler { try await call.value } onCancel: { call.cancel() }
      } catch is CancellationError {
        // A kick woke the long-poll: go round again and send what it brought. A cancelled sync stops.
        if waitMs > 0, !Task.isCancelled { continue }
        break
      } catch RelayFailure.unauthorized where link.relay == RelayClient.defaultRelay {
        registerAgain(link)
        break
      } catch {
        if self.link == link {
          lastError = error.localizedDescription
          Changes.post(.relay)
        }
        break
      }
      // The user paired another relay or unpaired during the exchange: this response belongs to the old one.
      guard self.link == link else { break }
      reached = true
      lastContact = Date()
      lastError = nil
      let heldBefore = pagesAtRelay
      pagesAtRelay = Dictionary(notices.pages.map { ($0.agentId, $0) }) { $1 }
      sentNotices = notices.basis
      declinedConnects.subtract(declines)
      answered += outbox.filter { if case .failed = $0 { false } else { true } }.count
      let readers = applyAcks(response.acked, sent: outbox)
      noteReadCursors(response.readCursors ?? [], pages: [heldBefore, pagesAtRelay], answeredFor: readers)
      if let registry, response.registryRevision >= registry.revision {
        try? setRelayRegistryRevision(registry.revision)
      } else if response.registryRevision > registryRevision {
        // The relay remembers a newer registry than this phone, for example after a reinstall.
        registryRevision = response.registryRevision
        try? bumpRegistry()
      } else if response.wantsRegistry == true {
        try? setRelayRegistryRevision(0)
      }
      for digest in response.revokedKeys ?? [] {
        if let agent = agents.first(where: { $0.keyDigest == digest }) { try? disconnect(agent.id) }
      }
      var entries: [LedgerEntry] = []
      for incoming in response.requests {
        guard case let .readable(request) = incoming else {
          if case let .unreadable(id?, agentID?) = incoming, ledger[id] == nil {
            changeAnswers[id] = ChangeAnswer(outcome: .failed(id: id, reason: Self.unreadableReason), agentID: agentID, agentName: "", read: nil)
          }
          continue
        }
        switch request.query {
        case let .ask(question, filters, documents, newest):
          var asked = entry(request, question: question, filters: filters)
          if documents != .excerpt { asked.documents = documents }
          asked.recency = newest.map { .matches(limit: $0) }
          entries.append(asked)
        case let .recent(filters, limit, documents):
          var listed = entry(request, question: Self.listingTitle(filters, limit: limit), filters: filters)
          if documents != .excerpt { listed.documents = documents }
          listed.recency = .listing(limit: limit)
          entries.append(listed)
        case let .note(note):
          var noted = entry(request, question: await NoteBook.shared.describe(note), filters: nil)
          noted.note = note
          entries.append(noted)
        case let .changes(since, limit):
          if let answer = await answerChanges(request, since: since, limit: limit), self.link == link {
            changeAnswers[request.id] = answer
          }
        case .sources:
          if let answer = await answerSources(request), self.link == link {
            changeAnswers[request.id] = answer
          }
        }
      }
      guard self.link == link else { break }
      let fresh = (try? receive(entries)) ?? []
      received += fresh.count
      for id in fresh { await triage(id) }
      Changes.post(.relay)
      let noticesMoved = await self.notices().basis != sentNotices
      let moreToSend = !self.outbox().isEmpty || registryRevision > relayRegistryRevision || noticesMoved || !declinedConnects.isEmpty
      if !moreToSend || deadline.timeIntervalSinceNow < 6 { break }
    }
    return SyncReport(reachedRelay: reached, received: received, answered: answered)
  }

  /// Takes the cursors the relay reports. A cursor that moved without an answer from this phone means the relay served
  /// a page this phone sent ahead; History records that read with the page's counts.
  private func noteReadCursors(_ cursors: [WireCursor], pages: [[AgentID: WirePage]], answeredFor answered: Set<AgentID>) {
    defer { cursorsHeard = true }
    for read in cursors {
      let before = readCursors[read.agentId]
      readCursors[read.agentId] = read.cursor
      guard cursorsHeard, before != read.cursor, !answered.contains(read.agentId),
            let served = pages.compactMap({ $0[read.agentId] }).first(where: { $0.since == before && $0.page.nextCursor == read.cursor })
      else { continue }
      record(ChangeRead(
        id: "page_\(read.agentId.rawValue)_\(read.cursor)", agentID: read.agentId,
        agentName: agents.first { $0.id == read.agentId }?.name ?? "Disconnected agent", at: Date(),
        outcome: .servedFromPage(shown: served.page.events.count)))
    }
  }

  private func record(_ read: ChangeRead) {
    reads.removeAll { $0.id == read.id }
    reads.append(read)
    try? tables?.reads.put(read.id, read, position: read.at.timeIntervalSince1970)
    let excess = reads.count - Self.readsKept
    if excess > 0 {
      for old in reads.prefix(excess) { try? tables?.reads.delete(old.id) }
      reads.removeFirst(excess)
    }
    Changes.post(.requests)
  }

  private var presenceAllowsLoop: Bool {
    switch presence {
    case .foreground: true
    case let .grace(until): until > Date()
    case .suspended: false
    }
  }

  /// Keeps one long-poll loop alive while presence allows it.
  private func restartLoop() {
    loop?.cancel()
    loop = nil
    guard link != nil, presenceAllowsLoop else { return }
    loop = Task {
      _ = await self.sync(.backgroundGrace, deadline: Date().addingTimeInterval(15))
      var backoff: TimeInterval = 1
      while !Task.isCancelled, self.presenceAllowsLoop, self.link != nil {
        let report = await self.sync(.foreground, deadline: Date().addingTimeInterval(32))
        if report.reachedRelay {
          backoff = 1
        } else {
          await self.rest(backoff)
          backoff = min(backoff * 2, 30)
        }
      }
    }
  }

  private func rest(_ seconds: TimeInterval) async {
    let wait = Task { _ = try? await Task.sleep(for: .seconds(seconds)) }
    nap = wait
    await withTaskCancellationHandler { await wait.value } onCancel: { wait.cancel() }
    if nap == wait { nap = nil }
  }

  /// Starts one POST. A long-poll is kept in `parkedPoll`, so a kick can wake it.
  private func exchange(_ client: RelayClient, _ body: SyncBody) -> Task<SyncResponse, Error> {
    let call = Task { try await client.sync(body) }
    if body.waitMs > 0 { parkedPoll = call }
    return call
  }

  /// Sends a fresh outcome, registry or page now. A loop waiting in its long-poll or before a retry is woken; a loop
  /// in an exchange sends it before it waits again. Without a loop one bounded sync runs, never two at once.
  private func kick() {
    guard link != nil else { return }
    if loop != nil, presenceAllowsLoop {
      kicks += 1
      parkedPoll?.cancel()
      nap?.cancel()
      return
    }
    if kicked != nil {
      kickAgain = true
      return
    }
    kicked = Task {
      repeat {
        kickAgain = false
        _ = await sync(.backgroundGrace, deadline: Date().addingTimeInterval(15))
      } while kickAgain && link != nil
      kicked = nil
    }
  }

  /// The hosted relay no longer knows this iPhone's key, for example after its state was lost. Retrying the dead key
  /// would fail forever, so Puffer registers as a new device; agents connected through the old one connect again.
  private func registerAgain(_ stale: PairingLink) {
    guard link == stale else { return }
    pufferLog.notice("relay rejected the device key, registering again")
    try? forgetRelay()
    try? RelayKeychain.delete()
    link = nil
    UserDefaults.standard.set(false, forKey: Self.registeredKey)
    if !agents.isEmpty { setReconnectAgents(true) }
    Changes.post(.relay)
    Task { await self.ensureRegistered() }
  }

  private func setReconnectAgents(_ on: Bool) {
    reconnectAgents = on
    try? tables?.meta.put("reconnectAgents", MetaValue(key: "reconnectAgents", value: on ? 1 : 0), position: 0)
  }

  /// Drops the oldest settled entries the relay acknowledged beyond `ledgerKept`, rows first.
  private func pruneLedger() {
    let done = ledger.values.filter { $0.phase.tag != .received && $0.reported == $0.phase.tag }
    guard done.count > Self.ledgerKept, let tables else { return }
    let old = done.sorted { $0.receivedAt > $1.receivedAt }.dropFirst(Self.ledgerKept).map(\.id)
    do {
      try tables.ledger.db.transaction {
        for id in old { try tables.ledger.delete(id.rawValue) }
      }
      for id in old { ledger[id] = nil }
    } catch {
      pufferLog.error("ledger not pruned: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// Changes answers not acknowledged yet, then entries whose phase the relay has not acknowledged. The ledger part is
  /// derived; there is no outbox table.
  private func outbox() -> [WireOutcome] {
    // Only requests the relay handed over go back to it. Rows from older builds also hold requests asked on the phone
    // itself (`dev_` ids), and one id the relay rejects fails the whole sync.
    let pending = ledger.values
      .filter { $0.phase.tag != .received && $0.phase.tag != $0.reported && $0.id.rawValue.hasPrefix("rq_") }
      .sorted { $0.receivedAt < $1.receivedAt }
      .compactMap { entry -> WireOutcome? in
        switch entry.phase {
        case .received: return nil
        case let .shared(payload, _):
          let items = payload.items.map { item in
            WireSharedItem(
              title: item.title, text: item.text, document: item.document.flatMap(WireDocument.init), date: item.details?.date,
              folder: item.details?.folder, fileType: item.details?.fileType)
          }
          return .answered(id: entry.id, items: items)
        case let .note(result, _): return .note(id: entry.id, result)
        case .nothingFound: return .nothingFound(id: entry.id)
        case let .failed(reason, _): return .failed(id: entry.id, reason: reason)
        case .denied(.expired, _): return .expired(id: entry.id)
        case .denied: return .declined(id: entry.id)
        }
      }
    var budget = Self.outboxBytes
    var out: [WireOutcome] = []
    for outcome in (changeAnswers.values.map(\.outcome) + pending).prefix(100) {
      let bytes = outcome.payloadBytes
      if !out.isEmpty, bytes > budget { break }
      budget -= bytes
      out.append(outcome)
    }
    return out
  }

  /// One sync body stays under the relay's 24 MB cap. The rest goes in the next sync.
  private static let outboxBytes = 22 * 1024 * 1024

  /// Marks what the relay confirmed. An ack covers the phase that was sent, even when the relay kept an earlier
  /// terminal outcome, so the phone stops re-sending either way. A changes answer the relay took goes to History.
  /// Returns the agents whose changes answers it took.
  private func applyAcks(_ acks: [WireAck], sent: [WireOutcome]) -> Set<AgentID> {
    let sentIDs = Set(sent.map(\.id))
    var readers = Set<AgentID>()
    for ack in acks where sentIDs.contains(ack.id) {
      if let answer = changeAnswers.removeValue(forKey: ack.id) {
        if let outcome = answer.read {
          readers.insert(answer.agentID)
          record(ChangeRead(id: ack.id.rawValue, agentID: answer.agentID, agentName: answer.agentName, at: Date(), outcome: outcome))
        }
        continue
      }
      guard var entry = ledger[ack.id] else { continue }
      entry.reported = entry.phase.tag
      entry.phase = Self.withoutBytes(entry.phase)
      ledger[ack.id] = entry
      try? tables?.ledger.put(entry.id.rawValue, entry, position: entry.receivedAt.timeIntervalSince1970)
    }
    if !acks.isEmpty {
      pruneLedger()
      Changes.post(.requests)
    }
    return readers
  }

  /// Whole documents and note bodies go once the relay took them; History keeps what was sent.
  private static func withoutBytes(_ phase: RequestPhase) -> RequestPhase {
    switch phase {
    case let .shared(payload, at): .shared(payload.withoutBytes(), at: at)
    case let .note(result, at): .note(result.withoutBodies(), at: at)
    default: phase
    }
  }

  private func entry(_ wire: WireRequest, question: String, filters: SearchFilters?) -> LedgerEntry {
    let agent = agents.first { $0.id == wire.agentId }
    return LedgerEntry(
      id: wire.id, agentID: wire.agentId, agentName: agent?.name ?? "Disconnected agent", question: String(question.prefix(500)),
      filters: filters, receivedAt: wire.askedAt, expiresAt: wire.expiresAt,
      phase: agent == nil ? .denied(.agentRevoked, at: Date()) : .received, reported: nil)
  }

  /// How History names a listing, which has no question of its own.
  private static func listingTitle(_ filters: SearchFilters?, limit: Int) -> String {
    "Newest \(limit) items" + (filters?.source.map { " from \($0)" } ?? "")
  }

  /// Fetched by link, opened through its link, not declined, not yet an agent here and not expired.
  private func pendingConnects() -> [WireConnect] {
    let now = Date()
    let known = Set(agents.map(\.keyDigest))
    return fetchedConnects.values.sorted { $0.requestedAt < $1.requestedAt }.filter {
      openedLinks[$0.id] != nil && !declinedConnects.contains($0.id) && !known.contains($0.keyDigest) && $0.expiresAt > now
    }
  }

  /// Every new agent goes through here: stored with its digest only, pushed with the next registry snapshot.
  private func register(name: String, keyDigest: KeyDigest) throws -> Agent {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(utf16: 80)
    let agent = Agent(
      id: AgentID(rawValue: "ag_" + (try Self.randomToken(bytes: 9))), name: trimmed.isEmpty ? "Agent" : trimmed,
      keyDigest: keyDigest, connectedAt: Date())
    try tables?.agents.put(agent.id.rawValue, agent, position: agent.connectedAt.timeIntervalSince1970)
    agents.append(agent)
    if reconnectAgents { setReconnectAgents(false) }
    try bumpRegistry()
    Changes.post(.policy)
    kick()
    return agent
  }

  private func wireRegistry() -> WireRegistry {
    WireRegistry(revision: registryRevision, agents: agents.map { WireAgent(id: $0.id, name: $0.name, keyDigest: $0.keyDigest) })
  }

  private func setRelayRegistryRevision(_ revision: Int) throws {
    relayRegistryRevision = revision
    try tables?.meta.put("relayRegistryRevision", MetaValue(key: "relayRegistryRevision", value: revision), position: 0)
  }

  // MARK: change log

  /// Answers at once from the change log. No ledger entry; History records the read once the relay takes it.
  private func answerChanges(_ request: WireRequest, since: String?, limit: Int) async -> ChangeAnswer? {
    guard changeAnswers[request.id] == nil else { return nil }
    guard let agent = agents.first(where: { $0.id == request.agentId }) else {
      return ChangeAnswer(outcome: .declined(id: request.id), agentID: request.agentId, agentName: "", read: nil)
    }
    if answeredReads(by: agent.id) >= Self.changeReadsPerMinute {
      return ChangeAnswer(outcome: .declined(id: request.id), agentID: agent.id, agentName: agent.name, read: .rateLimited)
    }
    do {
      let events = try await PufferEngine.shared.changes(after: 0)
      let page = Self.changesPage(events, since: since, limit: limit, current: await currentCards(events))
      return ChangeAnswer(
        outcome: .changes(id: request.id, page), agentID: agent.id, agentName: agent.name, read: .answered(shown: page.events.count))
    } catch {
      pufferLog.error("changes \(request.id.rawValue, privacy: .public) deferred: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  /// Source names and document counts, at once.
  private func answerSources(_ request: WireRequest) async -> ChangeAnswer? {
    guard changeAnswers[request.id] == nil else { return nil }
    guard let agent = agents.first(where: { $0.id == request.agentId }) else {
      return ChangeAnswer(outcome: .declined(id: request.id), agentID: request.agentId, agentName: "", read: nil)
    }
    do {
      var counts: [String: Int] = [:]
      for item in try await PufferEngine.shared.newest(SearchFilters()) {
        counts[DocumentLabel.of(sourceUri: item.sourceUri, firstTitle: item.card.title).source.prefix(utf16: Triage.sourceLimit), default: 0] += 1
      }
      let sources = counts.map { WireSource(name: $0.key, count: $0.value) }.sorted { $0.name < $1.name }.prefix(200)
      return ChangeAnswer(outcome: .sources(id: request.id, Array(sources)), agentID: agent.id, agentName: agent.name, read: nil)
    } catch {
      pufferLog.error("sources \(request.id.rawValue, privacy: .public) deferred: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  /// Reads this phone answered for the agent in the last minute, taken by the relay or still waiting to be.
  private func answeredReads(by agent: AgentID) -> Int {
    let minuteAgo = Date().addingTimeInterval(-60)
    let taken = reads.filter { read in
      guard read.agentID == agent, read.at > minuteAgo, case .answered = read.outcome else { return false }
      return true
    }.count
    let waiting = changeAnswers.values.filter { answer in
      guard answer.agentID == agent, case .answered? = answer.read else { return false }
      return true
    }.count
    return taken + waiting
  }

  /// What a changes request since `since` gets now. A cursor ahead of the log, for example from before a reinstall,
  /// reads as no cursor. The one rule behind answers and behind the pages the relay serves while the phone sleeps.
  private static func changesPage(_ all: [ChangeEvent], since: String?, limit: Int, current: [DocumentKey: ItemCard]) -> WireChanges {
    let latest = all.last?.seq ?? 0
    let after = since.flatMap { Int64($0) }.flatMap { $0 <= latest ? $0 : nil }
    let page = Triage.changes(all.filter { $0.seq > (after ?? 0) }, since: after, limit: limit, current: current)
    return WireChanges(events: page.notices, nextCursor: String(page.nextCursor))
  }

  static let pageEvents = 50
  static let pageBytes = 24_000
  private static let pageEncoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }()

  private func noticesBasis() async -> NoticesBasis? {
    guard let latest = try? await PufferEngine.shared.recentChanges(limit: 1).first?.seq ?? 0 else { return nil }
    return NoticesBasis(latest: latest, agents: registryRevision, cursors: readCursors)
  }

  /// Every agent's head, the newest seq, and the page its next changes request would get. Both go on every sync.
  /// Recomputed only when the log, the agents or a read cursor moved.
  private func notices() async -> Notices {
    guard let basis = await noticesBasis() else { return .unavailable }
    if let cached = noticesCache, cached.basis == basis { return cached }
    guard let events = try? await PufferEngine.shared.changes(after: 0) else { return .unavailable }
    let current = await currentCards(events)
    let head = events.last?.seq ?? 0
    var pages: [WirePage] = []
    for agent in agents {
      let since = basis.cursors[agent.id]
      var limit = Self.pageEvents
      var page = Self.changesPage(events, since: since, limit: limit, current: current)
      while limit > 1, ((try? Self.pageEncoder.encode(page))?.count ?? 0) > Self.pageBytes {
        limit /= 2
        page = Self.changesPage(events, since: since, limit: limit, current: current)
      }
      pages.append(WirePage(agentId: agent.id, since: since, page: page))
    }
    let notices = Notices(basis: basis, heads: agents.map { WireHead(agentId: $0.id, seq: head) }, pages: pages)
    // A slower call never replaces a newer cache.
    if noticesCache?.basis.map({ $0.latest <= basis.latest }) ?? true { noticesCache = notices }
    return notices
  }

  private func currentCards(_ events: [ChangeEvent]) async -> [DocumentKey: ItemCard] {
    await PufferEngine.shared.currentCards(Set(events.map(\.document)))
  }

  // MARK: private

  /// Runs the request and writes its phase: a search or listing shares its top matches, a note request runs on
  /// NoteBook. A run that throws is retried after `checkRetryDelays`, then the request settles as failed. Returns true
  /// when it settled the entry.
  @discardableResult
  private func triage(_ id: RequestID) async -> Bool {
    guard let entry = ledger[id], entry.phase.tag == .received, checking[id] == nil else { return false }
    if let retry = checkRetries[id], retry.at > Date() { return false }
    guard let agent = agents.first(where: { $0.id == entry.agentID }) else {
      try? setPhase(id, .denied(.agentRevoked, at: Date()))
      Changes.post(.requests)
      return true
    }
    checking[id] = Date()
    defer { checking[id] = nil }
    do {
      let next: RequestPhase
      if let request = entry.note {
        switch try await NoteBook.shared.handle(request, requestID: id, agent: .agent(id: agent.id, name: agent.name)) {
        case let .done(result): next = .note(result, at: Date())
        case .nothingFound: next = .nothingFound(at: Date())
        case let .refused(reason): next = .failed(reason: reason, at: Date())
        }
      } else {
        try await PufferEngine.shared.start()
        let candidates = Triage.answer(
          try await hits(for: entry), extent: entry.documents ?? .excerpt, size: entry.recency?.limit ?? Triage.answerSize)
        if candidates.isEmpty {
          next = .nothingFound(at: Date())
        } else {
          next = .shared(await Egress.materialize(candidates, document: { await PufferEngine.shared.sourceDocument($0) }), at: Date())
        }
      }
      guard ledger[id]?.phase.tag == .received else { return false }
      checkRetries[id] = nil
      try setPhase(id, next)
      Changes.post(.requests)
      return true
    } catch {
      let reason = Self.failureReason(error)
      let failures = (checkRetries[id]?.failures ?? 0) + 1
      pufferLog.error("request \(id.rawValue, privacy: .public) attempt \(failures) failed: \(error.localizedDescription, privacy: .public)")
      guard ledger[id]?.phase.tag == .received else { return false }
      guard failures <= Self.checkRetryDelays.count else {
        fail(id, reason)
        return true
      }
      let delay = Self.checkRetryDelays[failures - 1]
      checkRetries[id] = CheckRetry(failures: failures, at: Date().addingTimeInterval(delay), reason: reason)
      Task {
        try? await Task.sleep(for: .seconds(delay))
        if await self.triage(id) { self.kick() }
      }
      return false
    }
  }

  /// What an ask weighs: the closest matches, the newest confident matches, or for a listing the newest items.
  private func hits(for entry: LedgerEntry) async throws -> [Hit] {
    let filters = entry.filters ?? SearchFilters()
    switch entry.recency {
    case nil:
      return try await PufferEngine.shared.search(entry.question, filters: filters)
    case let .matches(limit)?:
      let confident = try await PufferEngine.shared.search(entry.question, filters: filters, window: false)
      var seen = Set<String>()
      let best = confident.filter { seen.insert($0.item.sourceUri).inserted }
      return Array(best.sorted { $0.item.date > $1.item.date }.prefix(limit))
    case let .listing(limit)?:
      return try await PufferEngine.shared.newest(filters).prefix(limit).map { Hit(item: $0, score: 0, similarity: nil) }
    }
  }

  /// Settles a request the phone could not run, so the agent stops waiting and the user sees why.
  private func fail(_ id: RequestID, _ reason: String) {
    checkRetries[id] = nil
    guard ledger[id]?.phase.tag == .received else { return }
    try? setPhase(id, .failed(reason: reason, at: Date()))
    Changes.post(.requests)
    kick()
  }

  /// Short and safe to show the user and the agent. Engine errors already read that way; anything else is generic.
  private static func failureReason(_ error: Error) -> String {
    let text = (error as? PufferError)?.errorDescription ?? "Puffer could not run this on the phone."
    return text.prefix(utf16: 200)
  }

  private func setPhase(_ id: RequestID, _ phase: RequestPhase) throws {
    guard var entry = ledger[id] else { return }
    entry.phase = phase
    ledger[id] = entry
    try tables?.ledger.put(id.rawValue, entry, position: entry.receivedAt.timeIntervalSince1970)
  }

  private func expireStale() {
    let now = Date()
    var changed = false
    for entry in ledger.values where entry.phase.tag == .received && entry.expiresAt < now {
      let unchecked = checkRetries.removeValue(forKey: entry.id)?.reason ?? "It expired before the phone could run it."
      try? setPhase(entry.id, .failed(reason: unchecked, at: now))
      changed = true
    }
    if changed { Changes.post(.requests) }
  }

  private func bumpRegistry() throws {
    registryRevision += 1
    try tables?.meta.put("registryRevision", MetaValue(key: "registryRevision", value: registryRevision), position: 0)
  }

  static func randomToken(bytes count: Int) throws -> String {
    var bytes = [UInt8](repeating: 0, count: count)
    guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw BridgeError.noRandomness }
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

struct NoticesBasis: Equatable, Sendable {
  let latest: Int64
  /// The registry revision: a new or removed agent changes heads and pages.
  let agents: Int
  let cursors: [AgentID: String]
}

struct Notices: Sendable {
  /// nil when unavailable.
  let basis: NoticesBasis?
  /// nil keeps the relay's heads: they only decide pings, which carry no content.
  let heads: [WireHead]?
  let pages: [WirePage]

  /// The log could not be read: no pages the phone cannot vouch for.
  static let unavailable = Notices(basis: nil, heads: nil, pages: [])
}

/// A failed check waiting for its next attempt.
private struct CheckRetry {
  let failures: Int
  let at: Date
  let reason: String
}

struct MetaValue: Codable, Sendable {
  let key: String
  let value: Int
}
