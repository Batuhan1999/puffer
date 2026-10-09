import Foundation

// Notes: Markdown documents the user and agents write on this iPhone. NoteBook owns notes.db and is the only writer of
// it; NoteIndexer converges PufferEngine's index (and so search and the change log) to the live notes, the way Sources
// converges it to folders.

struct NoteID: RawRepresentable, Hashable, Codable, Sendable {
  let rawValue: String
}

struct NoteFolderID: RawRepresentable, Hashable, Codable, Sendable {
  let rawValue: String
}

/// Who wrote a note last. An agent keeps its name, so the marker still reads after it is disconnected.
enum NoteEditor: Codable, Sendable, Hashable {
  case user
  case agent(id: AgentID, name: String)
}

/// Where an imported note came from, so a later import updates it only while nobody edited it in Puffer.
struct NoteOrigin: Codable, Sendable, Hashable {
  /// Source, title and creation date of the original.
  let key: String
  /// The note's version right after an import wrote it. A higher version means it was edited here since.
  var version: Int
}

struct Note: Codable, Sendable, Hashable {
  let id: NoteID
  var folderID: NoteFolderID
  /// Markdown. The first line is the title.
  var body: String
  var pinned: Bool
  let createdAt: Date
  var modifiedAt: Date
  /// Bumped by every change to the body.
  var version: Int
  var lastEditor: NoteEditor
  /// Set while the note is in Recently Deleted.
  var deletedAt: Date?
  var origin: NoteOrigin?

  var title: String { NoteText.title(body) }
}

struct NoteFolder: Codable, Sendable, Hashable {
  let id: NoteFolderID
  var name: String
  var parentID: NoteFolderID?
  let createdAt: Date
}

/// A note handed over from outside: a Shortcut, a shared Markdown file, or the old Apple Notes source.
struct ImportedNote: Sendable {
  /// The original's title, part of the dedupe key.
  let title: String
  /// The whole Markdown body, title line included.
  let body: String
  let created: Date?
  let modified: Date?
  /// Folder name; nil is the import's default folder.
  let folder: String?
}

enum NoteText {
  /// The first non-empty line without heading, list or checklist marks, as Apple Notes shows a title.
  static func title(_ body: String) -> String {
    for line in body.split(whereSeparator: \.isNewline) {
      let text = plain(line)
      if !text.isEmpty { return text.prefix(utf16: 300) }
    }
    return ""
  }

  /// The text after the title line, flattened, for list rows and list answers.
  static func preview(_ body: String, limit: Int = 300) -> String {
    let lines = body.split(whereSeparator: \.isNewline).map(plain).filter { !$0.isEmpty }
    return lines.dropFirst().joined(separator: " ").prefix(utf16: limit)
  }

  private static let marks = ["- [ ] ", "- [x] ", "- [X] ", "* ", "- ", "+ "]

  static func plain(_ line: Substring) -> String {
    var text = line.trimmingCharacters(in: .whitespaces)
    if let mark = marks.first(where: text.hasPrefix) { text = String(text.dropFirst(mark.count)) }
    text = String(text.drop { $0 == "#" || $0 == ">" }).trimmingCharacters(in: .whitespaces)
    // Unverified (cloud): validate on the Mac. The note's inline Markdown and its <u>/<mark> tags, as words only.
    for (pattern, template) in inlineMarkup {
      text = pattern.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
    return text.trimmingCharacters(in: .whitespaces)
  }

  /// In order: attachments go, links keep their text, tags and paired marks go, then lone `*`/`_` emphasis and code.
  private static let inlineMarkup: [(NSRegularExpression, String)] = [
    ("!\\[[^\\]]*\\]\\([^)]*\\)", ""),
    ("\\[([^\\]]*)\\]\\([^)]*\\)", "$1"),
    ("</?u>|<mark[^>]*>|</mark>", ""),
    ("\\*\\*|~~|==", ""),
    ("(?<![\\p{L}\\p{N}\\\\*])\\*(?=\\S)(.+?)(?<=\\S)\\*(?![\\p{L}\\p{N}*])", "$1"),
    ("(?<![\\p{L}\\p{N}\\\\_])_(?=\\S)(.+?)(?<=\\S)_(?![\\p{L}\\p{N}_])", "$1"),
    ("`", ""),
    ("\\s{2,}", " "),
  ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

  /// `![alt](path)`: images are not imported, and the note says so where each one was.
  static func withoutImages(_ markdown: String) -> (text: String, images: Int) {
    let pattern = try! NSRegularExpression(pattern: "!\\[[^\\]]*\\]\\([^)]*\\)")
    let range = NSRange(markdown.startIndex..., in: markdown)
    let count = pattern.numberOfMatches(in: markdown, range: range)
    if count == 0 { return (markdown, 0) }
    return (pattern.stringByReplacingMatches(in: markdown, range: range, withTemplate: "[Image not imported]"), count)
  }
}

/// What one import wrote.
public struct NotesReport: Sendable {
  public var added = 0
  public var updated = 0
  public var unchanged = 0
  /// Edited or deleted in Puffer since the last import, so left as they are.
  public var kept = 0
}

actor NoteBook {
  static let shared = NoteBook()

  static let storeURL = PufferEngine.documents.appendingPathComponent("SQLite/notes.db")
  static let notesFolder = NoteFolderID(rawValue: "notes")
  static let importedFolder = "Imported"
  /// Recently Deleted keeps a note this long, as Apple Notes does.
  static let keepDeleted: TimeInterval = 30 * 24 * 60 * 60

  enum Write: Sendable {
    case written(Note)
    case conflict(Note)
    case missing
  }

  /// An agent write's outcome is kept this long under its request id. A request settles within a day.
  static let keepApplied: TimeInterval = 2 * 24 * 60 * 60

  /// `applied` holds the outcome of each agent write by request id (`applying`).
  private typealias Tables = (notes: DocumentTable, folders: DocumentTable, applied: DocumentTable)
  private var tables: Tables?
  private var notes: [NoteID: Note] = [:]
  private var folders: [NoteFolderID: NoteFolder] = [:]

  /// Idempotent. Seeds the Notes folder, purges notes past their time in Recently Deleted and moves the notes the old
  /// Apple Notes source kept as files into the store.
  func open() throws {
    if tables != nil { return }
    let db = try SQLiteDB(url: Self.storeURL, schema: ["notes", "folders", "applied"].map(DocumentTable.schema).joined())
    let opened: Tables = (
      notes: DocumentTable(db: db, name: "notes"), folders: DocumentTable(db: db, name: "folders"),
      applied: DocumentTable(db: db, name: "applied"))
    try opened.applied.delete(before: Date().addingTimeInterval(-Self.keepApplied).timeIntervalSince1970)
    try reload(from: opened)
    tables = opened
    if folders[Self.notesFolder] == nil {
      try save(NoteFolder(id: Self.notesFolder, name: "Notes", parentID: nil, createdAt: Date(timeIntervalSince1970: 0)))
    }
    let cutoff = Date().addingTimeInterval(-Self.keepDeleted)
    for note in notes.values where note.deletedAt.map({ $0 < cutoff }) ?? false {
      try opened.notes.delete(note.id.rawValue)
      notes[note.id] = nil
    }
    LegacyNotes.migrate(into: self)
    removeOrphanedAttachments()
  }

  /// Unverified (cloud): validate on the Mac. A purged note's files go with it; the sweep also clears folders left by
  /// purges from before this, and by notes closed empty.
  private func removeAttachments(of id: NoteID) {
    try? FileManager.default.removeItem(at: AttachmentStore(noteID: id.rawValue).folder)
  }

  private func removeOrphanedAttachments() {
    let folders = (try? FileManager.default.contentsOfDirectory(at: AttachmentStore.root, includingPropertiesForKeys: nil)) ?? []
    for folder in folders where notes[NoteID(rawValue: folder.lastPathComponent)] == nil {
      try? FileManager.default.removeItem(at: folder)
    }
  }

  // MARK: reads

  func allFolders() throws -> [NoteFolder] {
    try open()
    return folders.values.sorted { ($0.id == Self.notesFolder ? 0 : 1, $0.name.lowercased()) < ($1.id == Self.notesFolder ? 0 : 1, $1.name.lowercased()) }
  }

  /// Every note, Recently Deleted included.
  func allNotes() throws -> [Note] {
    try open()
    return Array(notes.values)
  }

  func live() throws -> [Note] {
    try open()
    return notes.values.filter { $0.deletedAt == nil }
  }

  func note(_ id: NoteID) throws -> Note? {
    try open()
    return notes[id]
  }

  func folderName(_ id: NoteFolderID) -> String { folders[id]?.name ?? "Notes" }

  /// Case-insensitive, as agents and Shortcuts name folders.
  func folder(named name: String) throws -> NoteFolder? {
    try open()
    let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return folders.values.first { $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
  }

  // MARK: writes

  /// `id` makes a retried create converge: the same id returns the note it already made.
  func create(body: String, folder: NoteFolderID? = nil, editor: NoteEditor, id: NoteID? = nil) throws -> Note {
    try open()
    if let id, let existing = notes[id] { return existing }
    let now = Date()
    let note = Note(
      id: id ?? Self.newID(), folderID: folder.flatMap { folders[$0]?.id } ?? Self.notesFolder, body: body, pinned: false,
      createdAt: now, modifiedAt: now, version: 1, lastEditor: editor, deletedAt: nil, origin: nil)
    try save(note)
    changed(editor)
    return note
  }

  /// Replaces the body. A `baseVersion` other than the current one is a conflict. An unchanged body writes nothing.
  func update(_ id: NoteID, body: String, baseVersion: Int? = nil, editor: NoteEditor) throws -> Write {
    try open()
    guard var note = notes[id], note.deletedAt == nil else { return .missing }
    if let baseVersion, baseVersion != note.version { return .conflict(note) }
    if note.body == body { return .written(note) }
    note.body = body
    note.modifiedAt = Date()
    note.version += 1
    note.lastEditor = editor
    try save(note)
    changed(editor)
    return .written(note)
  }

  /// Adds `text` as a new paragraph at the end.
  func append(_ id: NoteID, text: String, editor: NoteEditor) throws -> Write {
    try open()
    guard let note = notes[id], note.deletedAt == nil else { return .missing }
    return try update(id, body: Self.appending(text, to: note.body), editor: editor)
  }

  static func appending(_ text: String, to body: String) -> String {
    let head = body.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
    return head.isEmpty ? text : "\(head)\n\n\(text)"
  }

  func setPinned(_ id: NoteID, _ pinned: Bool) throws {
    try open()
    guard var note = notes[id], note.pinned != pinned else { return }
    note.pinned = pinned
    try save(note)
    changed(nil)
  }

  func move(_ id: NoteID, to folder: NoteFolderID) throws {
    try open()
    guard var note = notes[id], folders[folder] != nil, note.folderID != folder else { return }
    note.folderID = folder
    try save(note)
    changed(nil)
  }

  /// Moves the note to Recently Deleted. Returns it as it was, or nil when there was none to delete.
  func delete(_ id: NoteID, editor: NoteEditor) throws -> Note? {
    try open()
    guard var note = notes[id], note.deletedAt == nil else { return nil }
    let before = note
    note.deletedAt = Date()
    note.lastEditor = editor
    try save(note)
    changed(editor)
    return before
  }

  /// Back from Recently Deleted, into its folder or Notes when that folder is gone.
  func restore(_ id: NoteID) throws {
    try open()
    guard var note = notes[id], note.deletedAt != nil else { return }
    note.deletedAt = nil
    if folders[note.folderID] == nil { note.folderID = Self.notesFolder }
    try save(note)
    changed(.user)
  }

  /// Only from Recently Deleted.
  func purge(_ ids: [NoteID]) throws {
    try open()
    for id in ids where notes[id]?.deletedAt != nil {
      try tables?.notes.delete(id.rawValue)
      notes[id] = nil
      removeAttachments(of: id)
    }
    changed(nil)
  }

  func createFolder(named name: String) throws -> NoteFolder {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(utf16: 200)
    if let existing = try folder(named: trimmed.isEmpty ? "New Folder" : trimmed) { return existing }
    let folder = NoteFolder(id: NoteFolderID(rawValue: Self.newID().rawValue), name: trimmed.isEmpty ? "New Folder" : trimmed, parentID: nil, createdAt: Date())
    try save(folder)
    changed(nil)
    return folder
  }

  func renameFolder(_ id: NoteFolderID, to name: String) throws {
    try open()
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(utf16: 200)
    guard var folder = folders[id], !trimmed.isEmpty else { return }
    folder.name = trimmed
    try save(folder)
    changed(nil)
  }

  /// The folder goes, its notes go to Recently Deleted. Notes itself stays.
  func deleteFolder(_ id: NoteFolderID) throws {
    try open()
    guard id != Self.notesFolder, folders[id] != nil else { return }
    let now = Date()
    try transaction {
      for var note in notes.values where note.folderID == id && note.deletedAt == nil {
        note.deletedAt = now
        try save(note)
      }
      try tables?.folders.delete(id.rawValue)
      folders[id] = nil
    }
    changed(.user)
  }

  /// Runs one agent write and records its outcome under the request id in the same transaction. A re-run of the request
  /// (the relay delivering it again, or a crash before Bridge stored the answer) returns the recorded outcome and
  /// writes nothing.
  func applying(_ request: RequestID, _ write: () throws -> NoteOutcome) throws -> NoteOutcome {
    try open()
    if let recorded = try tables?.applied.get(NoteOutcome.self, id: request.rawValue) { return recorded }
    var outcome = NoteOutcome.nothingFound
    try transaction {
      outcome = try write()
      try tables?.applied.put(request.rawValue, outcome, position: Date().timeIntervalSince1970)
    }
    return outcome
  }

  /// One transaction for the whole list, so a Shortcut can hand over thousands of notes at once. A note seen before
  /// (same source, title and creation date) is updated only while nobody edited it in Puffer; one deleted here stays
  /// deleted. Indexing follows in the background.
  func importNotes(_ incoming: [ImportedNote], source: String, defaultFolder: String = importedFolder) throws -> NotesReport {
    try open()
    var report = NotesReport()
    let known = Dictionary(notes.values.compactMap { note in note.origin.map { ($0.key, note.id) } }) { first, _ in first }
    var seen: [String: Int] = [:]
    try transaction {
      for item in incoming {
        let base = "\(source)|\(item.title)|\(item.created.map { String(Int64($0.timeIntervalSince1970)) } ?? "")"
        let occurrence = seen[base, default: 0]
        seen[base] = occurrence + 1
        let key = occurrence == 0 ? base : "\(base)#\(occurrence)"
        if let id = known[key], var note = notes[id] {
          guard note.deletedAt == nil, note.version == note.origin?.version else {
            report.kept += 1
            continue
          }
          guard note.body != item.body else {
            report.unchanged += 1
            continue
          }
          note.body = item.body
          note.version += 1
          note.modifiedAt = item.modified ?? Date()
          note.origin?.version = note.version
          note.lastEditor = .user
          try save(note)
          report.updated += 1
        } else {
          let folder = try ensureFolder(item.folder ?? defaultFolder)
          let created = item.created ?? item.modified ?? Date()
          try save(Note(
            id: Self.newID(), folderID: folder, body: item.body, pinned: false, createdAt: created,
            modifiedAt: item.modified ?? created, version: 1, lastEditor: .user, deletedAt: nil,
            origin: NoteOrigin(key: key, version: 1)))
          report.added += 1
        }
      }
    }
    pufferLog.notice("notes import \(source, privacy: .public): \(report.added) added, \(report.updated) updated, \(report.unchanged) unchanged, \(report.kept) kept")
    if report.added + report.updated > 0 { changed(.user) }
    return report
  }

  // MARK: private

  private func ensureFolder(_ name: String) throws -> NoteFolderID {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(utf16: 200)
    let wanted = trimmed.isEmpty ? Self.importedFolder : trimmed
    if let existing = folders.values.first(where: { $0.name.caseInsensitiveCompare(wanted) == .orderedSame }) { return existing.id }
    let folder = NoteFolder(id: NoteFolderID(rawValue: Self.newID().rawValue), name: wanted, parentID: nil, createdAt: Date())
    try save(folder)
    return folder.id
  }

  /// The row first, then memory, so memory never holds what the store does not.
  private func save(_ note: Note) throws {
    try tables?.notes.put(note.id.rawValue, note, position: note.createdAt.timeIntervalSince1970)
    notes[note.id] = note
  }

  private func save(_ folder: NoteFolder) throws {
    try tables?.folders.put(folder.id.rawValue, folder, position: folder.createdAt.timeIntervalSince1970)
    folders[folder.id] = folder
  }

  /// One SQLite transaction. If it fails, the rows roll back and memory is read again from them.
  private func transaction(_ body: () throws -> Void) throws {
    guard let tables else { return }
    do {
      try tables.notes.db.transaction(body)
    } catch {
      try? reload(from: tables)
      throw error
    }
  }

  private func reload(from tables: Tables) throws {
    folders = Dictionary(try tables.folders.all(NoteFolder.self).map { ($0.id, $0) }) { $1 }
    notes = Dictionary(try tables.notes.all(Note.self, salvage: Self.salvage).map { ($0.id, $0) }) { $1 }
  }

  /// A row this build cannot decode keeps its id, body and what else reads, so the note stays in the list.
  private static func salvage(id: String, json: String) -> Note? {
    guard let fields = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return nil }
    let date = { (key: String) in (fields[key] as? Double).map(Date.init(timeIntervalSinceReferenceDate:)) }
    return Note(
      id: NoteID(rawValue: id), folderID: NoteFolderID(rawValue: fields["folderID"] as? String ?? notesFolder.rawValue),
      body: fields["body"] as? String ?? "", pinned: fields["pinned"] as? Bool ?? false, createdAt: date("createdAt") ?? Date(),
      modifiedAt: date("modifiedAt") ?? Date(), version: fields["version"] as? Int ?? 1, lastEditor: .user,
      deletedAt: date("deletedAt"), origin: nil)
  }

  /// The UI refetches; a content change also reindexes, an agent's at once and the user's after typing pauses.
  private func changed(_ editor: NoteEditor?) {
    Changes.post(.notes)
    guard let editor else { return }
    let delay: TimeInterval = if case .agent = editor { 0.2 } else { 2 }
    Task { await NoteIndexer.shared.schedule(after: delay) }
  }

  static func newID() -> NoteID { NoteID(rawValue: UUID().uuidString.lowercased()) }
}

/// How notes appear in PufferEngine: passages of kind note under `note:<id>`, keyed by version, so a new version is one
/// `updated` and a note in Recently Deleted is `removed`.
enum NoteIndex {
  static let prefix = "note:"

  static func sourceUri(_ id: NoteID) -> String { prefix + id.rawValue }

  static func noteID(_ sourceUri: String) -> NoteID? {
    sourceUri.hasPrefix(prefix) ? NoteID(rawValue: String(sourceUri.dropFirst(prefix.count))) : nil
  }

  static func document(_ note: Note, folder: String, replacing old: [ItemID]) -> TextDocument {
    let key = "\(sourceUri(note.id))#\(note.version)"
    let title = note.title.isEmpty ? NoteText.untitled : note.title
    let addedAt = Int64(note.createdAt.timeIntervalSince1970 * 1000)
    let passages = Chunker.chunk(note.body).enumerated().map { index, text in
      NewPassage(id: ItemID(rawValue: "\(key):\(index)"), kind: .note, title: title, text: text, sourceUri: sourceUri(note.id), addedAtMs: addedAt)
    }
    return TextDocument(
      passages: passages, metadata: .note(NoteMetadata(folder: folder, created: note.createdAt, modified: note.modifiedAt)),
      replacing: old)
  }
}

extension NoteText {
  static let untitled = "New Note"
}

/// Converges the index to the live notes. Single flight; a call during a run asks for one more run after it.
actor NoteIndexer {
  static let shared = NoteIndexer()
  /// Notes embedded and written together. Their passages are embedded in batches across notes.
  static let group = 24

  struct Progress: Sendable {
    var done: Int
    var total: Int
  }

  private var pending: Task<Void, Never>?
  private var running: Task<Void, Never>?
  private var again = false
  private(set) var progress: Progress?

  /// Debounced, so a burst of autosaves indexes once.
  func schedule(after delay: TimeInterval) {
    pending?.cancel()
    pending = Task {
      try? await Task.sleep(for: .seconds(delay))
      if !Task.isCancelled { await self.run() }
    }
  }

  func run() async {
    if let running {
      again = true
      return await running.value
    }
    // `running` clears in the same actor turn that last read `again`, so a call in between is never lost.
    let task = Task {
      repeat {
        again = false
        await reconcile()
      } while again
      running = nil
    }
    running = task
    await task.value
  }

  private func reconcile() async {
    let engine = PufferEngine.shared
    do {
      try await engine.start()
      guard case .ready = await engine.status().model else { return }
      let book = NoteBook.shared
      let live = try await book.live()
      let stored = await engine.documents().filter { $0.key.hasPrefix(NoteIndex.prefix) }
      var stale: [TextDocument] = []
      for note in live {
        let document = NoteIndex.document(note, folder: await book.folderName(note.folderID), replacing: stored[NoteIndex.sourceUri(note.id)] ?? [])
        if let first = document.passages.first {
          if await engine.sourceUri(of: first.id) == nil { stale.append(document) }
        } else if !document.replacing.isEmpty {
          stale.append(document)
        }
      }
      let liveUris = Set(live.map { NoteIndex.sourceUri($0.id) })
      let gone = stored.filter { !liveUris.contains($0.key) }.map(\.value)
      var changed = try await engine.remove(documents: gone) > 0
      if !stale.isEmpty {
        progress = Progress(done: 0, total: stale.count)
        Changes.post(.notes)
        defer {
          progress = nil
          Changes.post(.notes)
        }
        for start in stride(from: 0, to: stale.count, by: Self.group) {
          let batch = Array(stale[start ..< min(start + Self.group, stale.count)])
          changed = try await engine.putTexts(batch) > 0 || changed
          progress?.done = start + batch.count
          Changes.post(.notes)
        }
      }
      if changed { await Bridge.shared.libraryChanged() }
    } catch {
      pufferLog.error("notes not indexed: \(error.localizedDescription, privacy: .public)")
    }
  }
}

/// The Apple Notes source before notes were editable: one text file per note under Application Support/Notes/<source>,
/// named "<title> (<UTC creation date>).txt". Each moves into the notes store once; the folder then goes, and the next
/// Sources pass removes its files from the index.
enum LegacyNotes {
  static let parent = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Notes", isDirectory: true)

  private static let stamp: DateFormatter = {
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.timeZone = TimeZone(identifier: "UTC")
    format.dateFormat = "yyyy-MM-dd HH.mm.ss"
    return format
  }()

  /// Runs inside NoteBook.open, on its actor.
  static func migrate(into book: isolated NoteBook) {
    let files = FileManager.default
    guard let sources = try? files.contentsOfDirectory(atPath: parent.path) else { return }
    for source in sources where !source.hasPrefix(".") {
      let folder = parent.appendingPathComponent(source, isDirectory: true)
      let names = ((try? files.contentsOfDirectory(atPath: folder.path)) ?? []).filter { !$0.hasPrefix(".") }
      let incoming = names.compactMap { name -> ImportedNote? in
        let url = folder.appendingPathComponent(name)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        let (title, created) = parse((name as NSString).deletingPathExtension)
        return ImportedNote(title: title, body: NoteImport.body(title: title, text: text), created: created, modified: modified, folder: nil)
      }
      do {
        _ = try book.importNotes(incoming, source: source)
        try files.removeItem(at: folder)
        pufferLog.notice("moved \(incoming.count) notes of \(source, privacy: .public) into Notes")
      } catch {
        pufferLog.error("notes of \(source, privacy: .public) not moved: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  private static func parse(_ base: String) -> (title: String, created: Date?) {
    guard base.hasSuffix(")"), let open = base.range(of: " (", options: .backwards) else { return (base, nil) }
    let inside = String(base[open.upperBound ..< base.index(before: base.endIndex)])
    guard let date = stamp.date(from: inside) else { return (base, nil) }
    return (String(base[..<open.lowerBound]), date)
  }
}

/// Imports from Shortcuts and from shared Markdown files.
enum NoteImport {
  /// A Shortcut hands over a note's text, which may or may not begin with its title. The title becomes the first line.
  static func body(title: String, text: String) -> String {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedTitle.isEmpty || NoteText.title(text) == NoteText.title(trimmedTitle) { return text }
    return text.isEmpty ? trimmedTitle : "\(trimmedTitle)\n\(text)"
  }

  /// Sync Notes to Puffer and Add to Puffer: saved at once, made searchable in the background.
  static func fromShortcut(_ notes: [NoteInput], source: String, folder: String?) async throws -> NotesReport {
    let incoming = notes.map { note in
      ImportedNote(
        title: note.title, body: body(title: note.title, text: note.text), created: note.created, modified: note.modified,
        folder: folder?.isEmpty == false ? folder : nil)
    }
    let report = try await NoteBook.shared.importNotes(incoming, source: source.isEmpty ? "Apple Notes" : source)
    Task { await NoteIndexer.shared.run() }
    return report
  }

  struct MarkdownImport: Sendable {
    var notes = 0
    var images = 0
  }

  /// A Markdown file, or a folder of Markdown files and images (Apple Notes' Export as Markdown). Images are not
  /// imported; each note says where one was.
  static func markdown(_ url: URL) async throws -> MarkdownImport {
    var found: [URL] = []
    var images = 0
    let isFolder = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
    if isFolder {
      let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles])
      while let file = walker?.nextObject() as? URL {
        switch file.pathExtension.lowercased() {
        case "md", "markdown": found.append(file)
        case "png", "jpg", "jpeg", "heic", "gif", "tiff", "pdf": images += 1
        default: break
        }
      }
    } else {
      found = [url]
    }
    var notes: [ImportedNote] = []
    for file in found {
      guard let raw = try? String(contentsOf: file, encoding: .utf8) else { continue }
      let (text, dropped) = NoteText.withoutImages(raw)
      images += dropped
      let values = try? file.resourceValues(forKeys: [.creationDateKey, .contentModificationDateKey])
      let title = file.deletingPathExtension().lastPathComponent
      notes.append(ImportedNote(
        title: title, body: body(title: title, text: text), created: values?.creationDate, modified: values?.contentModificationDate,
        folder: nil))
    }
    let report = try await NoteBook.shared.importNotes(notes, source: "Markdown")
    Task { await NoteIndexer.shared.run() }
    return MarkdownImport(notes: report.added + report.updated + report.unchanged + report.kept, images: images)
  }
}
