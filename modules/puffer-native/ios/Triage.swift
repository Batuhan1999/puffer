import Foundation

// What leaves the phone. Every connected agent reads everything, so nothing here asks the user. `SharedItem` and
// `ChangeNotice` have fileprivate initializers, so an item leaves only through `Egress` and a change-log entry only
// through `Triage.changes`, with the relay's limits applied there.

/// What of a document leaves when one of its passages is shared: the passage, the document's full text, or its original
/// file. The agent picks it per ask (include_documents).
enum Extent: String, Codable, Sendable, Hashable { case excerpt, text, file }

/// One answer row, frozen when the request was checked.
struct Candidate: Sendable, Hashable {
  let itemID: ItemID
  let kind: ItemKind
  let title: String
  /// Exactly the text that leaves, byte for byte.
  let excerpt: String
  let extent: Extent
  let details: SharedDetails?
}

extension String {
  /// The longest run of whole characters from the start that fits `limit` UTF-16 units. The relay's limits count UTF-16
  /// units, and a cut inside a character would leave half an emoji.
  func prefix(utf16 limit: Int) -> String {
    if utf16.count <= limit { return self }
    var used = 0
    var end = startIndex
    for index in indices {
      used += self[index].utf16.count
      if used > limit { break }
      end = self.index(after: index)
    }
    return String(self[..<end])
  }
}

enum Triage {
  static let answerSize = 3
  static let titleLimit = 300
  static let excerptLimit = 800
  static let changeExcerptLimit = 200
  static let sourceLimit = 200

  /// `hits` come from canonical search, already cut by `Ranking.relevant`. The top `size` go out; a recency request
  /// asked for exactly `size` items.
  static func answer(_ hits: [Hit], extent: Extent, size: Int = answerSize) -> [Candidate] {
    hits.prefix(size).map { hit in
      let card = hit.item.card
      return Candidate(
        itemID: card.id, kind: card.kind, title: card.title.prefix(utf16: titleLimit),
        excerpt: (card.snippet ?? "").prefix(utf16: excerptLimit), extent: extent, details: hit.item.metadata?.shared)
    }
  }
}

// MARK: change log

extension Triage {
  /// One page. `events` are every retained event after `since`, oldest first. Without a cursor the page is the newest
  /// `limit` events; with one, the oldest `limit` after it.
  static func changes(_ events: [ChangeEvent], since: Int64?, limit: Int, current: [DocumentKey: ItemCard]) -> ChangesPage {
    let span = since == nil ? Array(events.suffix(limit)) : Array(events.prefix(limit))
    return ChangesPage(
      notices: span.map { notice($0, current: current[$0.document]) }, nextCursor: span.last?.seq ?? since ?? 0)
  }

  private static func notice(_ event: ChangeEvent, current: ItemCard?) -> ChangeNotice {
    let title = event.title.prefix(utf16: titleLimit)
    if event.kind == .removed {
      return ChangeNotice(kind: .removed, at: event.at, itemKind: nil, title: title, source: nil, excerpt: nil)
    }
    return ChangeNotice(
      kind: event.kind, at: event.at, itemKind: event.itemKind, title: title, source: event.source.prefix(utf16: sourceLimit),
      excerpt: current.map { ($0.snippet ?? "").prefix(utf16: changeExcerptLimit) })
  }
}

/// What an agent sees of one change. Only `Triage.changes` builds one. A removal names its title only.
struct ChangeNotice: Encodable, Sendable {
  let kind: ChangeKind
  let at: Date
  /// Always "passage", which the relay still requires; a note goes as a passage from the source Notes.
  let itemKind: String?
  let title: String
  let source: String?
  let excerpt: String?

  fileprivate init(kind: ChangeKind, at: Date, itemKind: ItemKind?, title: String, source: String?, excerpt: String?) {
    self.kind = kind
    self.at = at
    self.itemKind = itemKind.map { _ in "passage" }
    self.title = title
    self.source = source
    self.excerpt = excerpt
  }
}

struct ChangesPage: Sendable {
  let notices: [ChangeNotice]
  let nextCursor: Int64
}

/// What leaves the phone for one item. No ids, no paths, no vectors.
struct SharedItem: Codable, Sendable, Hashable {
  let title: String
  let kind: ItemKind
  let text: String?
  private(set) var details: SharedDetails?
  /// The whole document, when the agent asked for it.
  private(set) var document: WholeDocument?

  fileprivate init(title: String, kind: ItemKind, text: String?, details: SharedDetails?, document: WholeDocument? = nil) {
    self.title = title
    self.kind = kind
    self.text = text
    self.details = details
    self.document = document
  }

  /// The bytes go once the relay acknowledged the answer. The ledger still records that a whole document was shared.
  func withoutBytes() -> SharedItem {
    SharedItem(title: title, kind: kind, text: text, details: details, document: document?.sent)
  }
}

/// The whole of a shared document, beyond its excerpt.
enum WholeDocument: Codable, Sendable, Hashable {
  /// Its full text from the stored passages, cut at the caps. `fileMissing` says why the file was asked for and the
  /// text went instead.
  case text(String, truncated: Bool, fileMissing: FileMissing?)
  case file(DocumentFile)
  /// Went to the relay; only what went is kept.
  case sent(Extent)

  var sent: WholeDocument {
    switch self {
    case .text: .sent(.text)
    case .file: .sent(.file)
    case .sent: self
    }
  }
}

enum FileMissing: String, Codable, Sendable { case tooLarge, unavailable, answerLimit }

struct DocumentFile: Codable, Sendable, Hashable {
  let name: String
  let mimeType: String
  let data: Data
}

/// Reading a document's original file for a shared passage.
enum FileRead: Sendable {
  case file(DocumentFile)
  case tooLarge
  /// Not found, no access, a note (which has no file), or an iCloud file that did not download in time.
  case unavailable
}

/// A stored document as Egress needs it.
struct SourceDocument: Sendable {
  /// Tells documents apart within one answer, so each goes whole once. Never leaves the phone.
  let key: String
  /// Its passages in order.
  let text: String
  let file: @Sendable () async -> FileRead
}

struct SharedPayload: Codable, Sendable, Hashable {
  let items: [SharedItem]

  func withoutBytes() -> SharedPayload {
    SharedPayload(items: items.map { $0.withoutBytes() })
  }
}

enum Egress {
  /// One original file per answer, at most 15 MB (20 MB as base64), so one answer fits the relay's 24 MB sync body cap.
  /// Further documents go as text.
  static let filesPerAnswer = 1
  static let fileLimit = 15 * 1024 * 1024
  /// A document's full text is cut here, and an answer's at `answerTextLimit`, in UTF-16 units as the relay counts.
  static let documentTextLimit = 200_000
  static let answerTextLimit = 400_000

  /// The only constructor of SharedItem. Text is the candidate's excerpt. A passage whose extent asks for more brings
  /// its whole document once per answer.
  static func materialize(_ candidates: [Candidate], document: (ItemID) async -> SourceDocument?) async -> SharedPayload {
    var items: [SharedItem] = []
    var filesLeft = filesPerAnswer
    var textLeft = answerTextLimit
    var wholeSent = Set<String>()
    for candidate in candidates {
      var whole: WholeDocument? = nil
      if candidate.extent != .excerpt, let source = await document(candidate.itemID), wholeSent.insert(source.key).inserted {
        whole = await self.whole(source, candidate.extent, filesLeft: &filesLeft, textLeft: &textLeft)
      }
      items.append(SharedItem(title: candidate.title, kind: candidate.kind, text: candidate.excerpt, details: candidate.details, document: whole))
    }
    return SharedPayload(items: items)
  }

  /// The file when asked for and the answer has one left, otherwise the text within what the answer has left.
  private static func whole(_ source: SourceDocument, _ extent: Extent, filesLeft: inout Int, textLeft: inout Int) async -> WholeDocument {
    var missing: FileMissing? = nil
    if extent == .file {
      if filesLeft == 0 {
        missing = .answerLimit
      } else {
        switch await source.file() {
        case let .file(file):
          filesLeft -= 1
          return .file(file)
        case .tooLarge: missing = .tooLarge
        case .unavailable: missing = .unavailable
        }
      }
    }
    let text = source.text.prefix(utf16: min(documentTextLimit, textLeft))
    textLeft -= text.utf16.count
    return .text(text, truncated: text.utf16.count < source.text.utf16.count, fileMissing: missing)
  }
}
