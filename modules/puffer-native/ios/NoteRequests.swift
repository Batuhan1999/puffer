import Foundation

// Agent note operations (design/notes/CONTRACT.md sections 3 and 4). Every connected agent may run them; the phone
// answers at once and History records each one.

/// One agent note request, as the ledger keeps it.
enum NoteRequest: Codable, Sendable, Hashable {
  case search(query: String, folder: String?, recent: Bool, limit: Int)
  case list(folder: String?, limit: Int)
  case folders
  case get(NoteID)
  case create(title: String?, body: String, folder: String?)
  case append(NoteID, text: String)
  case update(NoteID, body: String, baseVersion: Int)
  case delete(NoteID)

  var writes: Bool {
    switch self {
    case .create, .append, .update, .delete: true
    case .search, .list, .folders, .get: false
    }
  }
}

// Unverified (cloud): validate on the Mac
/// A note write the relay queued while this phone was offline (design/notes/CONTRACT.md section 3a). `noteID`: on a
/// create, the id the relay already told the agent, which the note keeps.
struct QueuedWrite: Codable, Sendable, Hashable {
  let at: Date
  let noteID: NoteID?
}

/// A note as an answer carries it. `snippet` for summaries, `body` for a whole note; either may be absent.
struct NoteView: Codable, Sendable, Hashable {
  let id: NoteID
  let title: String
  let folder: String
  let created: Date
  let modified: Date
  let version: Int
  let pinned: Bool
  var snippet: String?
  var body: String?
  /// Set when `body` is cut at the wire limit.
  var truncated: Bool?
}

struct NoteFolderCount: Codable, Sendable, Hashable {
  let name: String
  let count: Int
}

enum NoteResult: Codable, Sendable, Hashable {
  case notes([NoteView])
  case folders([NoteFolderCount])
  case note(NoteView)
  case conflict(currentVersion: Int)

  /// Bodies go once the relay took the answer; History keeps titles.
  func withoutBodies() -> NoteResult {
    switch self {
    case let .note(view):
      var kept = view
      kept.body = nil
      return .note(kept)
    case .notes, .folders, .conflict:
      return self
    }
  }
}

enum NoteOutcome: Codable, Sendable {
  case done(NoteResult)
  case nothingFound
  /// Not run, for a reason the agent can act on. Settles as failed without retries.
  case refused(String)
}

extension NoteBook {
  static let bodyLimit = 200_000

  /// Runs one agent request. Writes carry the agent as their editor, so the note shows "Edited by". A create's note id
  /// comes from the request id, so a retried request converges on the note it made. A `queued` write (written while
  /// this phone was offline) creates under the relay-minted id and merges a stale update instead of answering conflict.
  func handle(_ request: NoteRequest, requestID: RequestID, agent: NoteEditor, queued: QueuedWrite? = nil) async throws -> NoteOutcome {
    try open()
    // Unverified (cloud): validate on the Mac
    let outcome = try await perform(request, requestID: requestID, agent: agent, queued: queued)
    // The body an agent was handed, by version, so a later queued update_note can merge from it.
    if case let .done(.note(view)) = outcome, view.body != nil { try? rememberBase(view.id) }
    return outcome
  }

  private func perform(_ request: NoteRequest, requestID: RequestID, agent: NoteEditor, queued: QueuedWrite?) async throws -> NoteOutcome {
    switch request {
    case let .search(query, folder, recent, limit):
      var folderID: NoteFolderID?
      if let folder {
        guard let found = try self.folder(named: folder) else { return .nothingFound }
        folderID = found.id
      }
      var seen = Set<NoteID>()
      var views: [NoteView] = []
      var searchError: Error?
      do {
        for hit in try await PufferEngine.shared.search(query, filters: SearchFilters(kind: .note), window: !recent) {
          guard let id = NoteIndex.noteID(hit.item.sourceUri), let note = try self.note(id), note.deletedAt == nil,
                folderID.map({ $0 == note.folderID }) ?? true, seen.insert(id).inserted
          else { continue }
          views.append(view(note, snippet: hit.item.card.snippet ?? ""))
        }
      } catch {
        searchError = error
      }
      // The words themselves, as the app's own search does: an exact name or number, and notes not indexed yet.
      for note in try live().sorted(by: { $0.modifiedAt > $1.modifiedAt })
      where folderID.map({ $0 == note.folderID }) ?? true && !seen.contains(note.id) {
        guard let line = Self.line(of: note.body, containing: query) else { continue }
        seen.insert(note.id)
        views.append(view(note, snippet: line))
      }
      if views.isEmpty, let searchError { throw searchError }
      if recent { views.sort { $0.modified > $1.modified } }
      return views.isEmpty ? .nothingFound : .done(.notes(Array(views.prefix(limit))))

    case let .list(folder, limit):
      var notes = try live()
      if let folder {
        guard let found = try self.folder(named: folder) else { return .nothingFound }
        notes = notes.filter { $0.folderID == found.id }
      }
      let views = notes.sorted { $0.modifiedAt > $1.modifiedAt }.prefix(limit).map { view($0, snippet: NoteText.preview($0.body, limit: 1000)) }
      return views.isEmpty ? .nothingFound : .done(.notes(Array(views)))

    case .folders:
      let live = try self.live()
      let counts = try allFolders().prefix(200).map { folder in
        NoteFolderCount(name: folder.name, count: live.filter { $0.folderID == folder.id }.count)
      }
      return .done(.folders(counts))

    case let .get(id):
      guard let note = try note(id), note.deletedAt == nil else { return .nothingFound }
      return .done(.note(view(note, body: true)))

    case let .create(title, body, folder):
      return try applying(requestID) {
        let folderID = try folder.map { try createFolder(named: $0).id }
        let text = title.map { NoteImport.body(title: $0, text: body) } ?? body
        // Unverified (cloud): validate on the Mac
        // A queued create keeps the id the relay told the agent; a note with it already is this create's replay.
        let note = try create(body: text, folder: folderID, editor: agent, id: queued?.noteID ?? Self.noteID(for: requestID))
        if note.deletedAt != nil { return .refused("Puffer made this note for this request, and it was deleted since.") }
        return .done(.note(view(note, body: true)))
      }

    case let .append(id, text):
      return try applying(requestID) {
        guard let note = try note(id), note.deletedAt == nil else { return .nothingFound }
        if Self.appending(text, to: note.body).utf16.count > Self.bodyLimit {
          return .refused("This would make the note longer than 200,000 characters. Start a new note instead.")
        }
        return written(try append(id, text: text, editor: agent))
      }

    case let .update(id, body, baseVersion):
      return try applying(requestID) {
        guard let note = try note(id), note.deletedAt == nil else { return .nothingFound }
        if note.body.utf16.count > Self.bodyLimit {
          return .refused("This note is over 200,000 characters, so agents see only its start and cannot replace it. Edit it in Puffer.")
        }
        // Unverified (cloud): validate on the Mac
        // Written while offline against a version the user has edited since: both sides' lines survive, as when the
        // user and an agent edit at once (NoteSession). Without the body at baseVersion it stays a conflict.
        if queued != nil, note.version != baseVersion, let base = try base(of: id, version: baseVersion) {
          let merged = NoteMerge.merge(base: base, ours: note.body, theirs: body)
          if merged.utf16.count > Self.bodyLimit {
            return .refused("Merged with the user's edits, this note would be longer than 200,000 characters. Read it again and retry.")
          }
          return written(try update(id, body: merged, baseVersion: note.version, editor: agent))
        }
        return written(try update(id, body: body, baseVersion: baseVersion, editor: agent))
      }

    case let .delete(id):
      return try applying(requestID) {
        guard let note = try delete(id, editor: agent) else { return .nothingFound }
        return .done(.note(view(note, body: false)))
      }
    }
  }

  /// The first line of `body` that holds `query`, ignoring case and accents, flattened for a snippet.
  private static func line(of body: String, containing query: String) -> String? {
    let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard wanted.count > 1 else { return nil }
    return body.split(whereSeparator: \.isNewline)
      .first { $0.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
      .map(NoteText.plain)
  }

  /// How History names a request: what it did and to which note, by the title it has now.
  func describe(_ request: NoteRequest) -> String {
    func titled(_ id: NoteID) -> String {
      let title = (try? note(id))?.title ?? ""
      return "“\(title.isEmpty ? NoteText.untitled : title)”"
    }
    switch request {
    case let .search(query, folder, _, _): return "Search notes for “\(query)”" + (folder.map { " in \($0)" } ?? "")
    case let .list(folder, _): return folder.map { "List notes in \($0)" } ?? "List recent notes"
    case .folders: return "List note folders"
    case let .get(id): return "Read \(titled(id))"
    case let .create(title, body, _):
      let name = title ?? NoteText.title(body)
      return "Create “\(name.isEmpty ? NoteText.untitled : name)”"
    case let .append(id, _): return "Add to \(titled(id))"
    case let .update(id, _, _): return "Edit \(titled(id))"
    case let .delete(id): return "Delete \(titled(id))"
    }
  }

  private func written(_ write: Write) -> NoteOutcome {
    switch write {
    case let .written(note): .done(.note(view(note, body: true)))
    case let .conflict(note): .done(.conflict(currentVersion: note.version))
    case .missing: .nothingFound
    }
  }

  private func view(_ note: Note, snippet: String? = nil, body: Bool = false) -> NoteView {
    let folder = folderName(note.folderID)
    return NoteView(
      id: note.id, title: note.title, folder: folder.isEmpty ? "Notes" : folder.prefix(utf16: 200), created: note.createdAt,
      modified: note.modifiedAt, version: note.version, pinned: note.pinned, snippet: snippet?.prefix(utf16: 1000),
      body: body ? note.body.prefix(utf16: Self.bodyLimit) : nil,
      truncated: body && note.body.utf16.count > Self.bodyLimit ? true : nil)
  }

  /// `rq_<id>` becomes `rq-<id>`, within the contract's 64 characters.
  private static func noteID(for request: RequestID) -> NoteID {
    NoteID(rawValue: String(request.rawValue.replacingOccurrences(of: "_", with: "-").prefix(64)))
  }
}
