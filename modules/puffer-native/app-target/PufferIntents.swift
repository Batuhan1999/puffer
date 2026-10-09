// Compiled into the app target by the puffer-native config plugin; App Intents metadata is extracted only from there.
// Every call goes through `Puffer`.
import AppIntents
internal import PufferNative

/// Adds notes without removing any: notes from "Find Notes", or one note's title and text, for example inside
/// "Repeat with Each" where the note's dates and folder are at hand.
struct AddToPufferIntent: AppIntent {
  static let title: LocalizedStringResource = "Add to Puffer"
  static let description = IntentDescription("Saves notes or text as notes in Puffer on this iPhone, where you and your agents can use them.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .background }

  /// Files, because Shortcuts keeps formatting only there: rich text comes as HTML, text as a .txt file. The types must
  /// be a literal for the App Intents metadata to carry them.
  @Parameter(title: "Notes", supportedContentTypes: [.flatRTFD, .rtfd, .rtf, .html, .plainText], inputConnectionBehavior: .connectToPreviousIntentResult)
  var notes: [IntentFile]?
  @Parameter(title: "Title") var noteTitle: String?
  @Parameter(title: "Text") var text: String?
  @Parameter(title: "Created") var created: Date?
  @Parameter(title: "Modified") var modified: Date?
  @Parameter(title: "Folder") var folder: String?
  @Parameter(title: "Source", default: "Apple Notes") var source: String

  static var parameterSummary: some ParameterSummary {
    Summary("Add \(\.$notes) to Puffer") {
      \.$noteTitle
      \.$text
      \.$created
      \.$modified
      \.$folder
      \.$source
    }
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let typed = text.map { NoteInput(title: noteTitle ?? String($0.prefix { !$0.isNewline }), text: $0, created: created, modified: modified) }
    let dialog = await Puffer.importFromShortcut(
      ShortcutNotes.inputs(notes, texts: nil), extra: typed.map { [$0] } ?? [], source: source, folder: folder)
    return .result(dialog: "\(dialog)")
  }
}

/// Find Notes (All Notes, no limit), then this: every note comes over in one run. Running it again adds new notes and
/// updates the ones nobody edited in Puffer since; notes edited or deleted in Puffer stay as they are.
struct SyncNotesIntent: AppIntent {
  static let title: LocalizedStringResource = "Sync Notes to Puffer"
  static let description = IntentDescription(
    "Imports the notes as editable notes in Puffer. New notes are added, notes you have not edited in Puffer are updated.")
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .background }

  @Parameter(title: "Notes", supportedContentTypes: [.flatRTFD, .rtfd, .rtf, .html, .plainText], inputConnectionBehavior: .connectToPreviousIntentResult)
  var notes: [IntentFile]?
  /// For notes that do not arrive as files. Shortcuts hands these over as plain text, without formatting.
  @Parameter(title: "Notes as Text") var texts: [String]?
  @Parameter(title: "Folder") var folder: String?
  @Parameter(title: "Source", default: "Apple Notes") var source: String

  static var parameterSummary: some ParameterSummary {
    Summary("Sync \(\.$notes) to Puffer") {
      \.$texts
      \.$folder
      \.$source
    }
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let dialog = await Puffer.importFromShortcut(ShortcutNotes.inputs(notes, texts: texts), source: source, folder: folder)
    return .result(dialog: "\(dialog)")
  }
}

enum ShortcutNotes {
  static func inputs(_ files: [IntentFile]?, texts: [String]?) -> [ShortcutInput] {
    (files ?? []).map { .file(name: $0.filename, type: $0.type?.identifier, data: $0.data) } + (texts ?? []).map(ShortcutInput.text)
  }
}
