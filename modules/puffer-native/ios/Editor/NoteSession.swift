import Foundation

/// One open note in the editor. Saves run one at a time with the version this editor last saw as their base; when an
/// agent wrote in between, the agent's body is merged with the user's edits (common base: what this editor last loaded
/// or wrote) and the merge is saved, so neither side's change is lost.
@MainActor
final class NoteSession {
  private static let open = NSMapTable<NSString, NoteSession>.strongToWeakObjects()
  private static var lastSave: [NoteID: Task<Void, Never>] = [:]

  let id: NoteID
  var onNote: (Note) -> Void = { _ in }
  private let read: @MainActor () -> String
  private let show: @MainActor (String, Bool) -> Void
  /// The editor's Markdown for the body it last loaded or wrote.
  private var base = ""
  private var baseVersion = 0
  private var queue: Task<Void, Never>?

  /// `read` serializes the editor; `show` loads Markdown into it, keeping the cursor when the flag is set.
  init(id: NoteID, read: @escaping @MainActor () -> String, show: @escaping @MainActor (String, Bool) -> Void) {
    self.id = id
    self.read = read
    self.show = show
  }

  func load() async -> Note? {
    guard let note = try? await NoteBook.shared.note(id) else { return nil }
    show(note.body, false)
    base = read()
    baseVersion = note.version
    Self.open.setObject(self, forKey: id.rawValue as NSString)
    onNote(note)
    return note
  }

  /// Queues a save behind the running one; the returned task finishes when this one has.
  @discardableResult
  func save() -> Task<Void, Never> {
    let previous = queue
    let task = Task { @MainActor in
      await previous?.value
      await self.write()
    }
    queue = task
    Self.lastSave[id] = task
    return task
  }

  private func write() async {
    var body = read()
    for _ in 0..<5 {
      guard body != base else { return }
      let result: NoteBook.Write
      do {
        result = try await NoteBook.shared.update(id, body: body, baseVersion: baseVersion, editor: .user)
      } catch {
        pufferLog.error("note save failed: \(error.localizedDescription, privacy: .public)")
        return
      }
      switch result {
      case let .written(note):
        base = body
        baseVersion = note.version
        onNote(note)
        return
      case let .conflict(note):
        // Read again: keystrokes typed while the write was in flight belong to the user's side.
        let ours = read()
        let theirs = NoteDocument(markdown: note.body).markdown
        let merged = NoteMerge.merge(base: base, ours: ours, theirs: theirs)
        base = theirs
        baseVersion = note.version
        if merged != ours { show(merged, true) }
        onNote(note)
        body = read()
      case .missing:
        return
      }
    }
  }

  /// Someone else changed the note: load their version when nothing is unsaved here, else merge through a save.
  func refresh() async {
    await queue?.value
    guard let note = try? await NoteBook.shared.note(id) else { return }
    onNote(note)
    guard note.version > baseVersion else { return }
    if read() == base {
      show(note.body, true)
      base = read()
      baseVersion = note.version
    } else {
      await save().value
    }
  }

  /// Leaving a note: waits for its last save, then removes it for good when it is empty, as Apple Notes does.
  static func close(_ id: NoteID) async {
    if let session = open.object(forKey: id.rawValue as NSString) {
      await session.save().value
    } else {
      await lastSave[id]?.value
    }
    lastSave[id] = nil
    guard let note = try? await NoteBook.shared.note(id), note.deletedAt == nil,
          note.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    _ = try? await NoteBook.shared.delete(id, editor: .user)
    try? await NoteBook.shared.purge([id])
    try? FileManager.default.removeItem(at: AttachmentStore(noteID: id.rawValue).folder)
  }
}
