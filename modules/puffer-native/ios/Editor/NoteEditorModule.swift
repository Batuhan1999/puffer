import ExpoModulesCore
import UIKit

/// The editor's JS boundary, kept apart from PufferModule: the native view, leaving a note, and what the Tiptap editor
/// (src/ui/editor/TiptapNoteView.tsx) needs from native: saving, merging, attachments, note links, export, paper.
public class NoteEditorModule: Module {
  /// Attachment flows the Tiptap editor started, per note; their pickers hold delegates weakly.
  private var flows: [String: AttachmentFlows] = [:]

  public func definition() -> ModuleDefinition {
    Name("PufferEditor")

    Events("onAttachmentsAdded", "onAttachmentChanged")

    /// Waits for the note's last save, then removes it if it is empty, as Apple Notes does.
    AsyncFunction("closeNote") { (id: String) async in
      await NoteSession.close(NoteID(rawValue: id))
    }

    /// One save with the version the editor last saw as base. A conflict returns the newer note to merge with.
    AsyncFunction("saveNote") { (id: String, body: String, baseVersion: Int) async throws -> [String: Any] in
      switch try await NoteBook.shared.update(NoteID(rawValue: id), body: body, baseVersion: baseVersion, editor: .user) {
      case let .written(note): ["kind": "written", "note": PufferModule.encode(note, body: true)]
      case let .conflict(note): ["kind": "conflict", "note": PufferModule.encode(note, body: true)]
      case .missing: ["kind": "missing"]
      }
    }

    /// NoteMerge: both sides' line changes survive; where they touch, the agent's lines come first.
    Function("mergeNote") { (base: String, ours: String, theirs: String) -> String in
      NoteMerge.merge(base: base, ours: ours, theirs: theirs)
    }

    AsyncFunction("attachmentPreview") { (noteId: String, file: String, name: String, width: Double) -> [String: Any] in
      AttachmentImages.preview(AttachmentRef(name: name, file: file), store: AttachmentStore(noteID: noteId), width: CGFloat(width))
    }

    /// Starts a picker, the scanner or a drawing; what it saves arrives as `onAttachmentsAdded`.
    AsyncFunction("attach") { (noteId: String, kind: String) in
      MainActor.assumeIsolated {
        guard let kind = AttachmentFlows.Kind(rawValue: kind) else { return }
        self.flows(noteId).start(kind)
      }
    }.runOnQueue(.main)

    /// Quick Look, or the drawing canvas for a drawing; an edited drawing arrives as `onAttachmentChanged`.
    AsyncFunction("openAttachment") { (noteId: String, file: String, name: String) in
      MainActor.assumeIsolated { self.flows(noteId).open(AttachmentRef(name: name, file: file)) }
    }.runOnQueue(.main)

    /// A pasted image, as base64, saved next to the note's other files.
    AsyncFunction("saveAttachment") { (noteId: String, base64: String, ext: String, name: String) throws -> [String: String] in
      guard let data = Data(base64Encoded: base64) else { throw Exception(name: "BadAttachment", description: "not base64") }
      let ref = try AttachmentStore(noteID: noteId).save(data, ext: ext, name: name)
      return ["name": ref.name, "file": ref.file]
    }

    /// The `>>` sheet: resolves to the picked note, or null when dismissed.
    AsyncFunction("pickNoteLink") { (excluding: String, promise: Promise) in
      Task { @MainActor in
        let notes = ((try? await NoteBook.shared.live()) ?? []).filter { $0.id.rawValue != excluding && !$0.title.isEmpty }.sorted { $0.modifiedAt > $1.modifiedAt }
        guard !notes.isEmpty else { return promise.resolve(nil) }
        let picker = NoteLinkPicker(notes: notes.map { ($0.id.rawValue, $0.title) }) { picked in
          promise.resolve(picked.map { ["id": $0.id, "title": $0.title] })
        }
        let navigation = UINavigationController(rootViewController: picker)
        navigation.sheetPresentationController?.detents = [.medium(), .large()]
        self.present(navigation)
      }
    }

    /// `text`, `markdown`, `pdf` or `print`, from the editor's Markdown.
    AsyncFunction("shareNote") { (noteId: String, kind: String, markdown: String) in
      MainActor.assumeIsolated {
        let store = AttachmentStore(noteID: noteId)
        let width: CGFloat = 504
        NoteExport.share(NoteDocument(markdown: markdown), kind: kind, attachment: { ref in
          NoteTextAttachment(ref: ref, image: AttachmentImages.image(ref, store: store, width: width), width: width)
        }, sourceView: nil) { self.present($0) }
      }
    }.runOnQueue(.main)

    AsyncFunction("copyNote") { (markdown: String) in
      MainActor.assumeIsolated { NoteExport.copy(NoteDocument(markdown: markdown)) }
    }.runOnQueue(.main)

    Function("notePaper") { (noteId: String) -> String in
      NotePaper.of(noteId).rawValue
    }

    Function("setNotePaper") { (noteId: String, paper: String) in
      NotePaper(rawValue: paper)?.save(for: noteId)
    }

    View(NoteEditorView.self) {
      Events("onEditingChange", "onOpenNote")

      Prop("noteId") { (view: NoteEditorView, id: String) in
        MainActor.assumeIsolated { view.noteID = id }
      }

      AsyncFunction("finishEditing") { (view: NoteEditorView) in MainActor.assumeIsolated { view.finishEditing() } }.runOnQueue(.main)
      AsyncFunction("find") { (view: NoteEditorView) in MainActor.assumeIsolated { view.find() } }.runOnQueue(.main)
      AsyncFunction("share") { (view: NoteEditorView, kind: String) in MainActor.assumeIsolated { view.share(kind) } }.runOnQueue(.main)
      AsyncFunction("copyNote") { (view: NoteEditorView) in MainActor.assumeIsolated { view.copyNote() } }.runOnQueue(.main)
      AsyncFunction("moveCheckedToBottom") { (view: NoteEditorView) in MainActor.assumeIsolated { view.moveCheckedToBottom() } }.runOnQueue(.main)
      AsyncFunction("uncheckAll") { (view: NoteEditorView) in MainActor.assumeIsolated { view.uncheckAll() } }.runOnQueue(.main)
      AsyncFunction("toggleChecklist") { (view: NoteEditorView) in MainActor.assumeIsolated { view.toggleChecklist() } }.runOnQueue(.main)
      AsyncFunction("insertTable") { (view: NoteEditorView) in MainActor.assumeIsolated { view.insertTable() } }.runOnQueue(.main)
      AsyncFunction("attach") { (view: NoteEditorView, kind: String) in MainActor.assumeIsolated { view.attach(kind) } }.runOnQueue(.main)
      AsyncFunction("setPaper") { (view: NoteEditorView, paper: String) in MainActor.assumeIsolated { view.setPaper(paper) } }.runOnQueue(.main)
    }
  }

  @MainActor
  private func flows(_ noteId: String) -> AttachmentFlows {
    if let existing = flows[noteId] { return existing }
    let flow = AttachmentFlows()
    flow.store = AttachmentStore(noteID: noteId)
    flow.present = { [weak self] in self?.present($0) }
    flow.insert = { [weak self] refs in
      guard !refs.isEmpty else { return }
      self?.sendEvent("onAttachmentsAdded", ["noteId": noteId, "attachments": refs.map { ["name": $0.name, "file": $0.file] }])
    }
    flow.refresh = { [weak self] ref in self?.sendEvent("onAttachmentChanged", ["noteId": noteId, "file": ref.file]) }
    flows[noteId] = flow
    return flow
  }

  @MainActor
  private func present(_ controller: UIViewController) {
    guard var top = appContext?.utilities?.currentViewController() else { return }
    while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
    top.present(controller, animated: true)
  }
}
