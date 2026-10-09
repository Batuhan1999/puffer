import Foundation
import PDFKit

/// What Puffer knows about an item besides its content. One per stored item; a document's passages share it. The kind
/// follows where the item came from: a file in a folder or Shared with Puffer, or a note.
enum ItemMetadata: Codable, Sendable, Hashable {
  case file(FileMetadata)
  case note(NoteMetadata)

  /// What date filters compare: when a file or note was last modified.
  var date: Date? {
    switch self {
    case let .file(file): file.modified
    case let .note(note): note.modified
    }
  }

  /// Words for the keyword side of hybrid search.
  var keywordLine: String {
    var words: [String]
    switch self {
    case let .file(file):
      words = [file.name, file.folder, file.source, file.type]
      if let pdf = file.pdf { words += [pdf.title, pdf.author, pdf.subject].compactMap { $0 } + pdf.keywords }
    case let .note(note):
      words = [note.folder, "note"]
    }
    if let date { words.append(Self.monthYear.string(from: date)) }
    return words.filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// The part an agent receives with an item, cut to the relay's limits (protocol.ts SharedItem).
  var shared: SharedDetails {
    switch self {
    case let .file(file):
      let folder = file.folder.isEmpty ? file.source : "\(file.source)/\(file.folder)"
      return SharedDetails(date: file.modified, folder: folder.prefix(utf16: 1000), fileType: file.type.prefix(utf16: 20))
    case let .note(note):
      return SharedDetails(date: note.modified, folder: "Notes/\(note.folder)".prefix(utf16: 1000), fileType: nil)
    }
  }

  private static let monthYear: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MMMM yyyy"
    return formatter
  }()
}

struct FileMetadata: Codable, Sendable, Hashable {
  let name: String
  /// The containing folder's path inside the source, "" at its top.
  let folder: String
  /// The granted folder's display name, or Shared with Puffer.
  let source: String
  /// Lowercased extension.
  let type: String
  let created: Date?
  let modified: Date?
  let size: Int?
  let pdf: PdfAttributes?
}

struct NoteMetadata: Codable, Sendable, Hashable {
  /// The note's folder name.
  let folder: String
  let created: Date
  let modified: Date
}

struct PdfAttributes: Codable, Sendable, Hashable {
  let title: String?
  let author: String?
  let subject: String?
  let keywords: [String]
  let pages: Int
}

/// What an agent sees of an item beside its title and content.
struct SharedDetails: Codable, Sendable, Hashable {
  let date: Date?
  let folder: String?
  let fileType: String?
}

extension PdfAttributes {
  init(_ document: PDFDocument) {
    let attributes = document.documentAttributes ?? [:]
    func text(_ key: PDFDocumentAttribute) -> String? {
      (attributes[key] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
    }
    let keywords: [String] = switch attributes[PDFDocumentAttribute.keywordsAttribute] {
    case let list as [String]: list
    case let line as String: line.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    default: []
    }
    self.init(
      title: text(.titleAttribute), author: text(.authorAttribute), subject: text(.subjectAttribute),
      keywords: keywords.filter { !$0.isEmpty }, pages: document.pageCount)
  }
}
