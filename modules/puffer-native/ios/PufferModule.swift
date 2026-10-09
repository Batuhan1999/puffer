import ExpoModulesCore

/// The JS boundary: parse records into domain types, call the actors, encode results. JS never sees a vector.
public class PufferModule: Module {
  private let folders = FolderStore()
  private var folderPicker: FolderPickerDelegate?
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("Puffer")

    Constant("modelPath") { PufferEngine.modelURL.absoluteString }

    Events("onChange", "onIndexProgress")

    OnStartObserving {
      guard self.observers.isEmpty else { return }
      let center = NotificationCenter.default
      self.observers = [
        center.addObserver(forName: Changes.notification, object: nil, queue: .main) { [weak self] note in
          self?.sendEvent("onChange", ["topic": note.userInfo?["topic"] as? String ?? "items"])
        },
        center.addObserver(forName: IndexProgress.notification, object: nil, queue: .main) { [weak self] note in
          guard let progress = note.userInfo?["progress"] as? IndexProgress else { return }
          self?.sendEvent("onIndexProgress", Self.encode(progress))
        },
      ]
    }

    OnStopObserving {
      self.observers.forEach(NotificationCenter.default.removeObserver)
      self.observers = []
    }

    // engine

    AsyncFunction("start") { () async throws -> [String: Any] in
      try await PufferEngine.shared.start()
      return Self.encode(await PufferEngine.shared.status())
    }

    AsyncFunction("status") { () async -> [String: Any] in
      Self.encode(await PufferEngine.shared.status())
    }

    /// Indexes new or changed files in granted folders, and notes. Runs on its own as well; this is the fallback.
    AsyncFunction("syncSources") { () async -> [String: Int] in
      let s = await Sources.shared.catchUp()
      return ["files": s.files, "updated": s.updated, "removed": s.removed, "failed": s.failed]
    }

    AsyncFunction("indexProgress") { () async -> [String: Any] in
      Self.encode(await Sources.shared.snapshot)
    }

    AsyncFunction("takeShareReceipts") { () async -> [String] in
      await ShareInbox.shared.take()
    }

    // notes

    AsyncFunction("notesSnapshot") { () async throws -> [String: Any] in
      let book = NoteBook.shared
      let notes = try await book.allNotes()
      let folders = try await book.allFolders()
      var counts: [NoteFolderID: Int] = [:]
      for note in notes where note.deletedAt == nil { counts[note.folderID, default: 0] += 1 }
      let indexing = await NoteIndexer.shared.progress
      return [
        "folders": folders.map { ["id": $0.id.rawValue, "name": $0.name, "count": counts[$0.id] ?? 0] },
        "notes": notes.map { Self.encode($0, body: false) },
        "indexing": indexing.map { ["done": $0.done, "total": $0.total] as Any } ?? NSNull(),
      ]
    }

    AsyncFunction("note") { (id: String) async throws -> [String: Any]? in
      try await NoteBook.shared.note(NoteID(rawValue: id)).map { Self.encode($0, body: true) }
    }

    AsyncFunction("createNote") { (body: String, folderId: String?) async throws -> [String: Any] in
      Self.encode(try await NoteBook.shared.create(body: body, folder: folderId.map(NoteFolderID.init(rawValue:)), editor: .user), body: true)
    }

    AsyncFunction("setNotePinned") { (id: String, pinned: Bool) async throws in
      try await NoteBook.shared.setPinned(NoteID(rawValue: id), pinned)
    }

    AsyncFunction("moveNote") { (id: String, folderId: String) async throws in
      try await NoteBook.shared.move(NoteID(rawValue: id), to: NoteFolderID(rawValue: folderId))
    }

    AsyncFunction("deleteNote") { (id: String) async throws in
      _ = try await NoteBook.shared.delete(NoteID(rawValue: id), editor: .user)
    }

    AsyncFunction("restoreNote") { (id: String) async throws in
      try await NoteBook.shared.restore(NoteID(rawValue: id))
    }

    /// Only notes in Recently Deleted.
    AsyncFunction("purgeNotes") { (ids: [String]) async throws in
      try await NoteBook.shared.purge(ids.map(NoteID.init(rawValue:)))
    }

    AsyncFunction("createNoteFolder") { (name: String) async throws -> [String: Any] in
      let folder = try await NoteBook.shared.createFolder(named: name)
      return ["id": folder.id.rawValue, "name": folder.name, "count": 0]
    }

    AsyncFunction("renameNoteFolder") { (id: String, name: String) async throws in
      try await NoteBook.shared.renameFolder(NoteFolderID(rawValue: id), to: name)
    }

    AsyncFunction("deleteNoteFolder") { (id: String) async throws in
      try await NoteBook.shared.deleteFolder(NoteFolderID(rawValue: id))
    }

    /// Semantic search over notes: note ids in rank order, each with its best matching passage.
    AsyncFunction("searchNotes") { (text: String) async throws -> [[String: Any]] in
      let hits = try await PufferEngine.shared.search(text, filters: SearchFilters(kind: .note))
      var seen = Set<String>()
      return hits.compactMap { hit in
        guard let id = NoteIndex.noteID(hit.item.sourceUri), seen.insert(id.rawValue).inserted else { return nil }
        return ["noteId": id.rawValue, "snippet": hit.item.card.snippet ?? ""]
      }
    }

    // bridge

    AsyncFunction("snapshot") { () async throws -> [String: Any] in
      Self.encode(try await Bridge.shared.snapshot())
    }

    AsyncFunction("disconnectAgent") { (agentId: String) async throws in
      try await Bridge.shared.disconnect(AgentID(rawValue: agentId))
    }

    AsyncFunction("approveConnect") { (connectId: String, keyDigest: String) async throws -> String in
      try await Bridge.shared.approveConnect(ConnectID(rawValue: connectId), keyDigest: KeyDigest(rawValue: keyDigest)).rawValue
    }

    AsyncFunction("openConnectLink") { (connectId: String, secret: String) async throws in
      try await Bridge.shared.openConnectLink(ConnectID(rawValue: connectId), secret: secret)
    }

    AsyncFunction("declineConnect") { (connectId: String) async throws in
      try await Bridge.shared.declineConnect(ConnectID(rawValue: connectId))
    }

    AsyncFunction("pair") { (link: String) async throws in
      guard let url = URL(string: link) else { throw BadArgument("Not a URL: \(link)") }
      try await Bridge.shared.pair(url)
    }

    AsyncFunction("unpair") { () async throws in
      try await Bridge.shared.unpair()
    }

    // folders

    AsyncFunction("pickFolder") { (promise: Promise) in
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        return promise.reject(Exception(name: "NoViewController", description: "Nothing to present the folder picker from"))
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
      let delegate = FolderPickerDelegate { url in
        self.folderPicker = nil
        guard let url else { return promise.resolve(nil) }
        do {
          promise.resolve(try self.folders.add(url))
        } catch {
          promise.reject(error)
        }
      }
      self.folderPicker = delegate
      picker.delegate = delegate
      presenter.present(picker, animated: true)
    }.runOnQueue(.main)

    AsyncFunction("listFolders") { () -> [[String: String]] in
      self.folders.list()
    }

    AsyncFunction("removeFolder") { (id: String) in
      self.folders.remove(id)
      Task { await Sources.shared.catchUp() }
    }
  }

  static func encode(_ note: Note, body: Bool) -> [String: Any] {
    let editor: [String: Any] = switch note.lastEditor {
    case .user: ["kind": "user"]
    case let .agent(id, name): ["kind": "agent", "agentId": id.rawValue, "name": name]
    }
    var out: [String: Any] = [
      "id": note.id.rawValue, "folderId": note.folderID.rawValue, "title": note.title, "preview": NoteText.preview(note.body, limit: 160),
      "pinned": note.pinned, "createdAt": ms(note.createdAt), "modifiedAt": ms(note.modifiedAt), "version": note.version,
      "lastEditor": editor, "deletedAt": nullable(note.deletedAt.map(ms)),
    ]
    if body { out["body"] = note.body }
    return out
  }

  static func nullable(_ value: Double?) -> Any { value.map { $0 as Any } ?? NSNull() }
  static func nullable(_ value: String?) -> Any { value.map { $0 as Any } ?? NSNull() }
  static func ms(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

  static func encode(_ snapshot: BridgeSnapshot) -> [String: Any] {
    [
      "relay": encode(snapshot.relay),
      "agents": snapshot.agents.map { ["id": $0.id.rawValue, "name": $0.name, "connectedAt": ms($0.connectedAt)] },
      "requests": snapshot.requests.map(encode),
      "connects": snapshot.connects.map { c -> [String: Any] in
        let origin: [String: Any] = switch c.origin {
        case let .oauth(clientHost, redirectHost): ["kind": "oauth", "clientHost": nullable(clientHost), "redirectHost": redirectHost]
        case .link: ["kind": "link"]
        }
        return [
          "id": c.id.rawValue, "clientName": c.clientName, "origin": origin,
          "keyDigest": c.keyDigest.rawValue, "requestedAt": ms(c.requestedAt), "expiresAt": ms(c.expiresAt),
        ]
      },
      "reads": snapshot.reads.map(encode),
    ]
  }

  static func encode(_ read: ChangeRead) -> [String: Any] {
    let outcome: [String: Any] = switch read.outcome {
    case let .answered(shown): ["kind": "answered", "shown": shown]
    case let .servedFromPage(shown): ["kind": "servedFromPage", "shown": shown]
    case .rateLimited: ["kind": "rateLimited"]
    }
    return ["id": read.id, "agentId": read.agentID.rawValue, "agentName": read.agentName, "at": ms(read.at), "outcome": outcome]
  }

  static func encode(_ relay: RelayStatus) -> [String: Any] {
    switch relay {
    case .unpaired:
      return ["kind": "unpaired"]
    case let .paired(url, lastContact, lastError):
      return ["kind": "paired", "url": url.absoluteString, "lastContact": nullable(lastContact.map(ms)), "lastError": nullable(lastError)]
    }
  }

  static func encode(_ entry: LedgerEntry) -> [String: Any] {
    [
      "id": entry.id.rawValue, "agentId": entry.agentID.rawValue, "agentName": entry.agentName, "question": entry.question,
      "receivedAt": ms(entry.receivedAt), "phase": encode(entry.phase), "writes": entry.note?.writes ?? false,
      "delivered": entry.reported == entry.phase.tag,
    ]
  }

  static func encode(_ phase: RequestPhase) -> [String: Any] {
    switch phase {
    case .received:
      return ["kind": "received"]
    case let .shared(payload, at):
      return ["kind": "shared", "at": ms(at), "titles": payload.items.map(\.title)]
    case let .note(result, at):
      let detail: [String: Any] = switch result {
      case let .notes(notes): ["kind": "notes", "titles": notes.map(\.title)]
      case let .folders(folders): ["kind": "folders", "count": folders.count]
      case let .note(note): ["kind": "note", "noteId": note.id.rawValue, "title": note.title]
      case let .conflict(currentVersion): ["kind": "conflict", "currentVersion": currentVersion]
      }
      return ["kind": "note", "at": ms(at), "result": detail]
    case let .nothingFound(at):
      return ["kind": "nothingFound", "at": ms(at)]
    case let .denied(reason, at):
      return ["kind": "denied", "reason": reason.rawValue, "at": ms(at)]
    case let .failed(reason, at):
      return ["kind": "failed", "reason": reason, "at": ms(at)]
    }
  }

  static func encode(_ progress: IndexProgress) -> [String: Any] {
    let phase: [String: Any] = switch progress.phase {
    case .idle: ["kind": "idle"]
    case .waitingForModel: ["kind": "waitingForModel"]
    case .readingFiles: ["kind": "readingFiles"]
    case let .paused(until): ["kind": "paused", "until": until.rawValue]
    }
    return ["phase": phase, "files": ["done": progress.files.done, "total": progress.files.total, "failed": progress.files.failed]]
  }

  static func encode(_ status: EngineStatus) -> [String: Any] {
    let model: [String: Any] = switch status.model {
    case .absent: ["phase": "absent"]
    case .loading: ["phase": "loading"]
    case let .ready(backend, loadMs): ["phase": "ready", "backend": backend, "loadMs": loadMs]
    case let .failed(message): ["phase": "error", "message": message]
    }
    return ["model": model, "counts": ["passage": status.passages, "note": status.notes], "revision": status.revision]
  }
}

struct BadArgument: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
