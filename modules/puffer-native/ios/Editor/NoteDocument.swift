import Foundation

// A note as the editor sees it: paragraphs, each with one block style and inline runs. Markdown is only its storage
// format; `NoteMarkdown` is the one place that reads and writes it.

enum TextStyle: Hashable, Sendable { case title, heading, subheading, body }

enum ListKind: Hashable, Sendable {
  case bullet, dash, number
  case checklist(checked: Bool)
}

enum NoteBlock: Hashable, Sendable {
  case text(TextStyle, quoted: Bool)
  case list(ListKind, indent: Int, quoted: Bool)
  case mono
  case tableRow(header: Bool)

  static let body = NoteBlock.text(.body, quoted: false)
  static let maxIndent = 6

  var quoted: Bool {
    switch self {
    case let .text(_, quoted), let .list(_, _, quoted): quoted
    case .mono, .tableRow: false
    }
  }

  /// Title 1, Heading 2, Subheading 3: a section runs to the next heading of the same or a higher level.
  var headingLevel: Int? {
    switch self {
    case .text(.title, _): 1
    case .text(.heading, _): 2
    case .text(.subheading, _): 3
    default: nil
    }
  }

  var listKind: ListKind? {
    if case let .list(kind, _, _) = self { kind } else { nil }
  }

  var indent: Int {
    if case let .list(_, indent, _) = self { indent } else { 0 }
  }

  func quoting(_ on: Bool) -> NoteBlock {
    switch self {
    case let .text(style, _): .text(style, quoted: on)
    case let .list(kind, indent, _): .list(kind, indent: indent, quoted: on)
    case .mono, .tableRow: self
    }
  }

  func indented(by delta: Int) -> NoteBlock {
    guard case let .list(kind, indent, quoted) = self else { return self }
    return .list(kind, indent: min(Self.maxIndent, max(0, indent + delta)), quoted: quoted)
  }

  /// The block a new paragraph gets after Return at the end of this one.
  var next: NoteBlock {
    switch self {
    case let .text(_, quoted): .text(.body, quoted: quoted)
    case let .list(.checklist, indent, quoted): .list(.checklist(checked: false), indent: indent, quoted: quoted)
    case .list, .mono: self
    case .tableRow: .tableRow(header: false)
    }
  }
}

enum Highlight: String, CaseIterable, Hashable, Sendable { case purple, pink, orange, mint, blue }

struct InlineMarks: OptionSet, Hashable, Sendable {
  let rawValue: Int
  static let bold = InlineMarks(rawValue: 1)
  static let italic = InlineMarks(rawValue: 2)
  static let underline = InlineMarks(rawValue: 4)
  static let strike = InlineMarks(rawValue: 8)
  static let code = InlineMarks(rawValue: 16)
}

struct InlineStyle: Hashable, Sendable {
  var marks: InlineMarks = []
  var highlight: Highlight?
  var link: String?
}

/// A file under Documents/NoteAttachments/<note id>/, written in Markdown as `![name](attachment:<file>)`.
struct AttachmentRef: Hashable, Sendable {
  var name: String
  var file: String
}

enum NoteInline: Hashable, Sendable {
  case text(String, InlineStyle)
  case attachment(AttachmentRef)
}

struct NoteParagraph: Hashable, Sendable {
  var block: NoteBlock
  var inlines: [NoteInline]

  var plainText: String {
    inlines.map { inline in
      switch inline {
      case let .text(text, _): text
      case let .attachment(ref): "[\(ref.name)]"
      }
    }.joined()
  }
}

extension NoteParagraph {
  /// A table row's cells; tabs separate them in the text.
  var cells: [[NoteInline]] {
    var out: [[NoteInline]] = [[]]
    for inline in inlines {
      guard case let .text(text, style) = inline else {
        out[out.count - 1].append(inline)
        continue
      }
      for (n, part) in text.components(separatedBy: "\t").enumerated() {
        if n > 0 { out.append([]) }
        if !part.isEmpty { out[out.count - 1].append(.text(part, style)) }
      }
    }
    return out
  }

  init(cells: [[NoteInline]], header: Bool) {
    var inlines: [NoteInline] = []
    for (n, cell) in cells.enumerated() {
      if n > 0 { inlines.append(.text("\t", InlineStyle())) }
      inlines += cell
    }
    self.init(block: .tableRow(header: header), inlines: inlines)
  }
}

/// A link to another note, written `[Title](puffer://note/<id>)`.
enum NoteLink {
  static let prefix = "puffer://note/"

  static func url(_ id: String) -> String { prefix + id }

  static func noteID(_ link: String) -> String? {
    link.hasPrefix(prefix) ? String(link.dropFirst(prefix.count)) : nil
  }
}

struct NoteDocument: Hashable, Sendable {
  var paragraphs: [NoteParagraph]

  init(paragraphs: [NoteParagraph]) { self.paragraphs = paragraphs }
  init(markdown: String) { self = NoteMarkdown.parse(markdown) }
  var markdown: String { NoteMarkdown.serialize(self) }

  /// What Send a Copy shares: list marks as characters, attachments by name.
  var plainText: String {
    var numbers: [Int: Int] = [:]
    return paragraphs.map { paragraph in
      let text = paragraph.plainText
      guard case let .list(kind, indent, _) = paragraph.block else {
        numbers = [:]
        return text
      }
      numbers = numbers.filter { $0.key <= indent }
      let mark: String
      switch kind {
      case .bullet: mark = "•"
      case .dash: mark = "-"
      case .number:
        let n = (numbers[indent] ?? 0) + 1
        numbers[indent] = n
        mark = "\(n)."
      case let .checklist(checked): mark = checked ? "☑" : "☐"
      }
      return String(repeating: "\t", count: indent) + mark + " " + text
    }.joined(separator: "\n")
  }

  /// Within each run of checklist items, the checked ones go below the rest, in their order.
  mutating func moveCheckedToBottom() {
    var out: [NoteParagraph] = []
    var index = 0
    while index < paragraphs.count {
      guard case .list(.checklist, _, _) = paragraphs[index].block else {
        out.append(paragraphs[index])
        index += 1
        continue
      }
      var run: [NoteParagraph] = []
      while index < paragraphs.count, case .list(.checklist, _, _) = paragraphs[index].block {
        run.append(paragraphs[index])
        index += 1
      }
      let checked = run.filter { $0.block.listKind == .checklist(checked: true) }
      out += run.filter { $0.block.listKind != .checklist(checked: true) } + checked
    }
    paragraphs = out
  }

  mutating func uncheckAll() {
    for index in paragraphs.indices {
      if case let .list(.checklist(true), indent, quoted) = paragraphs[index].block {
        paragraphs[index].block = .list(.checklist(checked: false), indent: indent, quoted: quoted)
      }
    }
  }

  // MARK: tables

  /// The table holding paragraph `index`: the range of its rows.
  func table(at index: Int) -> Range<Int>? {
    guard paragraphs.indices.contains(index), case .tableRow = paragraphs[index].block else { return nil }
    var start = index
    while start > 0, case .tableRow = paragraphs[start - 1].block { start -= 1 }
    var end = index + 1
    while end < paragraphs.count, case .tableRow = paragraphs[end].block { end += 1 }
    return start..<end
  }

  /// A two-by-two table after paragraph `index`, header row first.
  mutating func insertTable(after index: Int) -> Int {
    let at = min(index + 1, paragraphs.count)
    paragraphs.insert(contentsOf: [
      NoteParagraph(block: .tableRow(header: true), inlines: [.text("\t", InlineStyle())]),
      NoteParagraph(block: .tableRow(header: false), inlines: [.text("\t", InlineStyle())]),
    ], at: at)
    if at + 2 == paragraphs.count { paragraphs.append(NoteParagraph(block: .body, inlines: [])) }
    return at
  }

  mutating func addRow(at index: Int, below: Bool) {
    guard let rows = table(at: index) else { return }
    let columns = paragraphs[index].cells.count
    let row = NoteParagraph(cells: Array(repeating: [], count: columns), header: false)
    if !below, index == rows.lowerBound {
      paragraphs[index].block = .tableRow(header: false)
      paragraphs.insert(NoteParagraph(cells: Array(repeating: [], count: columns), header: true), at: index)
    } else {
      paragraphs.insert(row, at: below ? index + 1 : index)
    }
  }

  mutating func deleteRow(at index: Int) {
    guard let rows = table(at: index) else { return }
    paragraphs.remove(at: index)
    if index == rows.lowerBound, rows.count > 1 { paragraphs[index].block = .tableRow(header: true) }
  }

  mutating func addColumn(at index: Int, column: Int, after: Bool) {
    guard let rows = table(at: index) else { return }
    for row in rows {
      var cells = paragraphs[row].cells
      cells.insert([], at: min(cells.count, after ? column + 1 : column))
      paragraphs[row] = NoteParagraph(cells: cells, header: row == rows.lowerBound)
    }
  }

  mutating func deleteColumn(at index: Int, column: Int) {
    guard let rows = table(at: index) else { return }
    if paragraphs[index].cells.count <= 1 {
      paragraphs.removeSubrange(rows)
      return
    }
    for row in rows {
      var cells = paragraphs[row].cells
      if cells.indices.contains(column) { cells.remove(at: column) }
      paragraphs[row] = NoteParagraph(cells: cells, header: row == rows.lowerBound)
    }
  }

}

// MARK: - Markdown

enum NoteMarkdown {
  static let attachmentScheme = "attachment:"

  // MARK: parse

  /// `implicitTitle`: the first line with text is the title, as in Apple Notes. Off for a pasted fragment.
  static func parse(_ markdown: String, implicitTitle: Bool = true) -> NoteDocument {
    let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .replacingOccurrences(of: "\u{2028}", with: "\n").replacingOccurrences(of: "\u{2029}", with: "\n").components(separatedBy: "\n")
    var paragraphs: [NoteParagraph] = []
    var listColumns: [Int] = []
    var i = 0
    while i < lines.count {
      let line = lines[i]
      let trimmed = line.drop { $0 == " " }
      if trimmed.hasPrefix("```") {
        listColumns = []
        i += 1
        while i < lines.count, !lines[i].drop(while: { $0 == " " }).hasPrefix("```") {
          paragraphs.append(NoteParagraph(block: .mono, inlines: lines[i].isEmpty ? [] : [.text(lines[i], InlineStyle())]))
          i += 1
        }
        i += 1
        continue
      }
      if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
        listColumns = []
        paragraphs.append(NoteParagraph(block: .tableRow(header: true), inlines: tableCells(line)))
        i += 2
        while i < lines.count, lines[i].drop(while: { $0 == " " }).hasPrefix("|") {
          paragraphs.append(NoteParagraph(block: .tableRow(header: false), inlines: tableCells(lines[i])))
          i += 1
        }
        continue
      }
      paragraphs.append(parseLine(line, listColumns: &listColumns))
      i += 1
    }
    let first = firstWithText(paragraphs)
    if implicitTitle, paragraphs.indices.contains(first), isPlainBody(paragraphs[first]) {
      // Unverified (cloud): validate on the Mac. A leading empty line keeps the first text as Body (serialize writes it
      // for a note whose first line was set to Body); same rule as src/ui/editor/markdown.ts.
      if first > 0, paragraphs[0].inlines.isEmpty {
        paragraphs.removeFirst()
      } else {
        paragraphs[first].block = .text(.title, quoted: false)
      }
    }
    return NoteDocument(paragraphs: paragraphs)
  }

  private static func parseLine(_ line: String, listColumns: inout [Int]) -> NoteParagraph {
    var rest = Substring(line)
    var quoted = false
    if rest.hasPrefix(">") {
      quoted = true
      rest = rest.dropFirst()
      if rest.hasPrefix(" ") { rest = rest.dropFirst() }
    }
    var column = 0
    while let c = rest.first, c == " " || c == "\t" {
      column += c == "\t" ? 4 : 1
      rest = rest.dropFirst()
    }
    if let (kind, content) = listItem(rest) {
      if let top = listColumns.last, column > top {
        listColumns.append(column)
      } else {
        while listColumns.count > 1, let top = listColumns.last, column < top { listColumns.removeLast() }
        if listColumns.isEmpty { listColumns = [column] }
      }
      let indent = min(NoteBlock.maxIndent, listColumns.count - 1)
      return NoteParagraph(block: .list(kind, indent: indent, quoted: quoted), inlines: parseInline(String(content)))
    }
    listColumns = []
    if column == 0, let (style, content) = heading(rest) {
      return NoteParagraph(block: .text(style, quoted: quoted), inlines: parseInline(String(content)))
    }
    let text = column == 0 ? String(rest) : String(repeating: " ", count: column) + rest
    return NoteParagraph(block: .text(.body, quoted: quoted), inlines: parseInline(text))
  }

  private static func listItem(_ s: Substring) -> (ListKind, Substring)? {
    for (prefix, kind) in [("- [ ] ", ListKind.checklist(checked: false)), ("- [x] ", .checklist(checked: true)),
                           ("- [X] ", .checklist(checked: true)), ("* [ ] ", .checklist(checked: false)),
                           ("* [x] ", .checklist(checked: true))] where s.hasPrefix(prefix) {
      return (kind, s.dropFirst(prefix.count))
    }
    if s == "- [ ]" { return (.checklist(checked: false), "") }
    if s == "- [x]" || s == "- [X]" { return (.checklist(checked: true), "") }
    if s.hasPrefix("- ") || s == "-" { return (.dash, s.dropFirst(min(2, s.count))) }
    if s.hasPrefix("* ") || s.hasPrefix("+ ") || s == "*" { return (.bullet, s.dropFirst(min(2, s.count))) }
    let digits = s.prefix { $0.isASCII && $0.isNumber }
    if !digits.isEmpty, digits.count < 10 {
      let after = s.dropFirst(digits.count)
      if after.hasPrefix(". ") || after.hasPrefix(") ") { return (.number, after.dropFirst(2)) }
      if after == "." || after == ")" { return (.number, "") }
    }
    return nil
  }

  private static func heading(_ s: Substring) -> (TextStyle, Substring)? {
    let hashes = s.prefix { $0 == "#" }
    guard (1...6).contains(hashes.count) else { return nil }
    let after = s.dropFirst(hashes.count)
    guard after.isEmpty || after.hasPrefix(" ") else { return nil }
    let style: TextStyle = hashes.count == 1 ? .title : hashes.count == 2 ? .heading : .subheading
    return (style, after.drop { $0 == " " })
  }

  private static func isTableSeparator(_ line: String) -> Bool {
    let cells = splitRow(line)
    return !cells.isEmpty && cells.allSatisfy { cell in
      let c = cell.trimmingCharacters(in: .whitespaces)
      return c.contains("-") && c.allSatisfy { $0 == "-" || $0 == ":" }
    }
  }

  private static func splitRow(_ line: String) -> [String] {
    var s = Substring(line.trimmingCharacters(in: .whitespaces))
    if s.hasPrefix("|") { s = s.dropFirst() }
    if s.hasSuffix("|"), !s.hasSuffix("\\|") { s = s.dropLast() }
    var cells: [String] = []
    var cell = ""
    var escaped = false
    for c in s {
      if escaped {
        if c != "|" { cell.append("\\") }
        cell.append(c)
        escaped = false
      } else if c == "\\" {
        escaped = true
      } else if c == "|" {
        cells.append(cell)
        cell = ""
      } else {
        cell.append(c)
      }
    }
    if escaped { cell.append("\\") }
    cells.append(cell)
    return cells
  }

  private static func tableCells(_ line: String) -> [NoteInline] {
    var out: [NoteInline] = []
    for (index, cell) in splitRow(line).enumerated() {
      if index > 0 { out.append(.text("\t", InlineStyle())) }
      out += parseInline(cell.trimmingCharacters(in: .whitespaces))
    }
    return merged(out)
  }

  // MARK: inline parse

  private struct Delimiter {
    let open: String
    let close: String
    /// `*`-style marks need text right inside them, so `2 * 3` stays text.
    let flanking: Bool
    let apply: (inout InlineStyle, Bool) -> Void
  }

  private static let delimiters: [Delimiter] = [
    Delimiter(open: "**", close: "**", flanking: true) { s, on in s.marks.set(.bold, on) },
    Delimiter(open: "__", close: "__", flanking: true) { s, on in s.marks.set(.bold, on) },
    Delimiter(open: "~~", close: "~~", flanking: true) { s, on in s.marks.set(.strike, on) },
    Delimiter(open: "==", close: "==", flanking: true) { s, on in s.highlight = on ? .purple : nil },
    Delimiter(open: "<u>", close: "</u>", flanking: false) { s, on in s.marks.set(.underline, on) },
    Delimiter(open: "*", close: "*", flanking: true) { s, on in s.marks.set(.italic, on) },
    Delimiter(open: "_", close: "_", flanking: true) { s, on in s.marks.set(.italic, on) },
  ]

  static func parseInline(_ text: String) -> [NoteInline] {
    var out: [NoteInline] = []
    var buffer = ""
    var style = InlineStyle()
    var open: [String] = []
    let chars = Array(text)
    var i = 0

    func flush() {
      if !buffer.isEmpty { out.append(.text(buffer, style)) }
      buffer = ""
    }
    func at(_ s: String, _ index: Int) -> Bool {
      let p = Array(s)
      return index + p.count <= chars.count && Array(chars[index..<index + p.count]) == p
    }
    func find(_ s: String, from: Int, escapes: Bool = true) -> Int? {
      var j = from
      while j < chars.count {
        if escapes, chars[j] == "\\" { j += 2; continue }
        if at(s, j) { return j }
        j += 1
      }
      return nil
    }
    func isWordChar(_ index: Int) -> Bool { index >= 0 && index < chars.count && (chars[index].isLetter || chars[index].isNumber) }
    func isSpace(_ index: Int) -> Bool { index < 0 || index >= chars.count || chars[index].isWhitespace }

    while i < chars.count {
      let c = chars[i]
      if c == "\\", i + 1 < chars.count, chars[i + 1].isPunctuation || chars[i + 1].isSymbol {
        buffer.append(chars[i + 1])
        i += 2
        continue
      }
      if c == "`" {
        let ticks = at("``", i) ? "``" : "`"
        if let end = find(ticks, from: i + ticks.count, escapes: false), end > i + ticks.count {
          flush()
          var code = String(chars[(i + ticks.count)..<end])
          if ticks == "``" { code = code.trimmingCharacters(in: .init(charactersIn: " ")) }
          var codeStyle = style
          codeStyle.marks.insert(.code)
          out.append(.text(code, codeStyle))
          i = end + ticks.count
          continue
        }
      }
      if c == "!", at("![", i), let (label, target, end) = linkParts(chars, from: i + 1), target.hasPrefix(attachmentScheme) {
        flush()
        out.append(.attachment(AttachmentRef(name: label, file: String(target.dropFirst(attachmentScheme.count)))))
        i = end
        continue
      }
      if c == "[", style.link == nil, let (label, target, end) = linkParts(chars, from: i) {
        flush()
        var linked = style
        linked.link = target
        for inline in parseInline(label) {
          if case let .text(t, s) = inline {
            var merged = s
            merged.marks.formUnion(linked.marks)
            merged.highlight = s.highlight ?? linked.highlight
            merged.link = target
            out.append(.text(t, merged))
          } else {
            out.append(inline)
          }
        }
        i = end
        continue
      }
      if c == "<", at("<mark", i), let close = find(">", from: i) {
        let tag = String(chars[i...close])
        flush()
        style.highlight = Highlight.allCases.first { tag.contains("\"\($0.rawValue)\"") || tag.contains("'\($0.rawValue)'") } ?? .purple
        open.append("</mark>")
        i = close + 1
        continue
      }
      if c == "<", at("</mark>", i), let index = open.lastIndex(of: "</mark>") {
        flush()
        style.highlight = nil
        open.remove(at: index)
        i += 7
        continue
      }
      var matched = false
      for d in delimiters where at(d.open, i) || at(d.close, i) {
        let isOpen = open.contains(d.close) && at(d.close, i)
        if isOpen {
          if d.flanking, isSpace(i - 1) { break }
          if d.open == "_", isWordChar(i + d.close.count) { break }
          flush()
          d.apply(&style, false)
          open.remove(at: open.lastIndex(of: d.close)!)
          i += d.close.count
          matched = true
          break
        }
        guard at(d.open, i), !open.contains(d.close) else { continue }
        if d.flanking, isSpace(i + d.open.count) { break }
        if d.open == "_", isWordChar(i - 1) { break }
        guard let end = find(d.close, from: i + d.open.count), end > i + d.open.count else { break }
        if d.flanking, isSpace(end - 1) { break }
        flush()
        d.apply(&style, true)
        open.append(d.close)
        i += d.open.count
        matched = true
        break
      }
      if matched { continue }
      buffer.append(c)
      i += 1
    }
    flush()
    return merged(out)
  }

  /// `[label](target)` starting at `from` (the `[`): label, target and the index after `)`.
  private static func linkParts(_ chars: [Character], from: Int) -> (String, String, Int)? {
    guard from < chars.count, chars[from] == "[" else { return nil }
    var depth = 0
    var j = from
    while j < chars.count {
      if chars[j] == "\\" { j += 2; continue }
      if chars[j] == "[" { depth += 1 }
      if chars[j] == "]" {
        depth -= 1
        if depth == 0 { break }
      }
      j += 1
    }
    guard j + 1 < chars.count, chars[j] == "]", chars[j + 1] == "(" else { return nil }
    guard let close = chars[(j + 2)...].firstIndex(of: ")") else { return nil }
    let target = String(chars[(j + 2)..<close]).trimmingCharacters(in: .whitespaces)
    guard !target.isEmpty, !target.contains(" ") else { return nil }
    return (String(chars[(from + 1)..<j]), target, close + 1)
  }

  private static func merged(_ inlines: [NoteInline]) -> [NoteInline] {
    var out: [NoteInline] = []
    for inline in inlines {
      if case let .text(t, _) = inline, t.isEmpty { continue }
      if case let .text(t, s) = inline, case let .text(prev, ps)? = out.last, ps == s {
        out[out.count - 1] = .text(prev + t, s)
      } else {
        out.append(inline)
      }
    }
    return out
  }

  // MARK: serialize

  static func serialize(_ document: NoteDocument) -> String {
    var lines: [String] = []
    var numbers: [Int: Int] = [:]
    var index = 0
    let paragraphs = document.paragraphs
    while index < paragraphs.count {
      let paragraph = paragraphs[index]
      switch paragraph.block {
      case .mono:
        lines.append("```")
        while index < paragraphs.count, paragraphs[index].block == .mono {
          lines.append(paragraphs[index].plainText)
          index += 1
        }
        lines.append("```")
        numbers = [:]
        continue
      case .tableRow:
        var first = true
        while index < paragraphs.count, case .tableRow = paragraphs[index].block {
          let cells = cellsOf(paragraphs[index].inlines)
          lines.append("| " + cells.joined(separator: " | ") + " |")
          if first { lines.append("|" + String(repeating: " --- |", count: max(1, cells.count))) }
          first = false
          index += 1
        }
        numbers = [:]
        continue
      case let .text(style, quoted):
        numbers = [:]
        let content = inlineMarkdown(paragraph.inlines)
        let line: String = switch style {
        case .title: content.isEmpty ? "" : "# " + content
        case .heading: content.isEmpty ? "##" : "## " + content
        case .subheading: content.isEmpty ? "###" : "### " + content
        case .body: escapedLineStart(content)
        }
        lines.append(quoted ? (line.isEmpty ? ">" : "> " + line) : line)
      case let .list(kind, indent, quoted):
        numbers = numbers.filter { $0.key <= indent }
        let mark: String
        switch kind {
        case .bullet: mark = "* "
        case .dash: mark = "- "
        case .number:
          let n = (numbers[indent] ?? 0) + 1
          numbers[indent] = n
          mark = "\(n). "
        case let .checklist(checked): mark = checked ? "- [x] " : "- [ ] "
        }
        let content = inlineMarkdown(paragraph.inlines)
        let line = String(repeating: "    ", count: indent) + (content.isEmpty ? String(mark.dropLast()) : mark + content)
        lines.append(quoted ? "> " + line : line)
      }
      index += 1
    }
    // The first text is Body, not the title: one empty line first, which parse takes back out.
    if paragraphs.indices.contains(firstWithText(paragraphs)), isPlainBody(paragraphs[firstWithText(paragraphs)]) {
      lines.insert("", at: 0)
    }
    return lines.joined(separator: "\n")
  }

  private static func firstWithText(_ paragraphs: [NoteParagraph]) -> Int {
    paragraphs.firstIndex { !$0.inlines.isEmpty } ?? 0
  }

  private static func isPlainBody(_ paragraph: NoteParagraph) -> Bool {
    paragraph.block == .body && !paragraph.inlines.isEmpty
  }

  private static func cellsOf(_ inlines: [NoteInline]) -> [String] {
    var cells: [[NoteInline]] = [[]]
    for inline in inlines {
      guard case let .text(text, style) = inline else {
        cells[cells.count - 1].append(inline)
        continue
      }
      let parts = text.components(separatedBy: "\t")
      for (n, part) in parts.enumerated() {
        if n > 0 { cells.append([]) }
        if !part.isEmpty { cells[cells.count - 1].append(.text(part, style)) }
      }
    }
    return cells.map { inlineMarkdown($0).replacingOccurrences(of: "|", with: "\\|") }
  }

  private static func escapedLineStart(_ content: String) -> String {
    let lead = content.prefix { $0 == " " }
    let rest = content.dropFirst(lead.count)
    if rest.hasPrefix("#") || rest.hasPrefix(">") || rest.hasPrefix("- ") || rest == "-" || rest.hasPrefix("+ ") || rest.hasPrefix("```") || rest.hasPrefix("|") {
      return lead + "\\" + rest
    }
    let digits = rest.prefix { $0.isASCII && $0.isNumber }
    if !digits.isEmpty {
      let after = rest.dropFirst(digits.count)
      if after.hasPrefix(". ") || after.hasPrefix(") ") || after == "." || after == ")" {
        return lead + digits + "\\" + after
      }
    }
    return content
  }

  /// One run of text with one style, before its marks are written.
  private struct Piece {
    var text: String
    var style: InlineStyle
    var attachment: AttachmentRef?
    /// The paragraph's text after this piece, which decides whether a `[` here could open a link.
    var following = ""
  }

  static func inlineMarkdown(_ inlines: [NoteInline]) -> String {
    var pieces: [Piece] = []
    for inline in merged(inlines) {
      switch inline {
      case let .attachment(ref): pieces.append(Piece(text: "", style: InlineStyle(), attachment: ref))
      case let .text(text, style): pieces += splitWhitespace(text, style)
      }
    }
    var after = ""
    for index in pieces.indices.reversed() {
      pieces[index].following = after
      after = pieces[index].text + after
    }
    var out = ""
    var start = 0
    while start < pieces.count {
      var end = start + 1
      while end < pieces.count, pieces[end].style.link == pieces[start].style.link, pieces[end].attachment == nil, pieces[start].attachment == nil { end += 1 }
      let group = Array(pieces[start..<end])
      if let link = group[0].style.link {
        out += "[" + marked(group, inLink: true) + "](" + link.replacingOccurrences(of: " ", with: "%20").replacingOccurrences(of: ")", with: "%29") + ")"
      } else {
        out += marked(group)
      }
      start = end
    }
    return out
  }

  /// Whitespace at either end of a `**`-style mark would stop it parsing as one, so it moves outside.
  private static func splitWhitespace(_ text: String, _ style: InlineStyle) -> [Piece] {
    let flankingMarks: InlineMarks = [.bold, .italic, .strike]
    guard !style.marks.intersection(flankingMarks).isEmpty || style.highlight != nil, !style.marks.contains(.code) else {
      return [Piece(text: text, style: style)]
    }
    let lead = text.prefix { $0.isWhitespace }
    let trail = text.dropFirst(lead.count).reversed().prefix { $0.isWhitespace }
    let core = text.dropFirst(lead.count).dropLast(trail.count)
    var outside = style
    outside.marks.subtract(flankingMarks)
    outside.highlight = nil
    var pieces: [Piece] = []
    if !lead.isEmpty { pieces.append(Piece(text: String(lead), style: outside)) }
    if !core.isEmpty { pieces.append(Piece(text: String(core), style: style)) }
    if !trail.isEmpty { pieces.append(Piece(text: String(trail.reversed()), style: outside)) }
    return pieces
  }

  private enum Mark: Hashable {
    case bold, italic, underline, strike, highlight(Highlight)

    var open: String {
      switch self {
      case .bold: "**"
      case .italic: "*"
      case .underline: "<u>"
      case .strike: "~~"
      case .highlight(.purple): "=="
      case let .highlight(color): "<mark data-color=\"\(color.rawValue)\">"
      }
    }

    var close: String {
      switch self {
      case .bold: "**"
      case .italic: "*"
      case .underline: "</u>"
      case .strike: "~~"
      case .highlight(.purple): "=="
      case .highlight: "</mark>"
      }
    }
  }

  private static func marks(of style: InlineStyle) -> [Mark] {
    var out: [Mark] = []
    if let highlight = style.highlight { out.append(.highlight(highlight)) }
    if style.marks.contains(.underline) { out.append(.underline) }
    if style.marks.contains(.strike) { out.append(.strike) }
    if style.marks.contains(.bold) { out.append(.bold) }
    if style.marks.contains(.italic) { out.append(.italic) }
    return out
  }

  /// Marks open and close as a stack, so `**a *b* c**` nests instead of reopening at every run.
  private static func marked(_ pieces: [Piece], inLink: Bool = false) -> String {
    var out = ""
    var stack: [Mark] = []
    for piece in pieces {
      if let ref = piece.attachment {
        while let top = stack.popLast() { out += top.close }
        out += "![" + ref.name.replacingOccurrences(of: "]", with: "") + "](" + attachmentScheme + ref.file + ")"
        continue
      }
      let wanted = marks(of: piece.style)
      var keep = 0
      while keep < stack.count, wanted.contains(stack[keep]) { keep += 1 }
      while stack.count > keep { out += stack.removeLast().close }
      for mark in wanted where !stack.contains(mark) {
        out += mark.open
        stack.append(mark)
      }
      if piece.style.marks.contains(.code) {
        let ticks = piece.text.contains("`") ? "``" : "`"
        let pad = ticks == "``" ? " " : ""
        out += ticks + pad + piece.text + pad + ticks
      } else {
        out += escaped(piece.text, inLink: inLink, following: piece.following)
      }
    }
    while let top = stack.popLast() { out += top.close }
    return out
  }

  /// Backslashes for every character that would otherwise read as Markdown. `~` and `=` at either end could join a
  /// neighbouring `~~` or `==`.
  private static func escaped(_ text: String, inLink: Bool, following: String) -> String {
    let chars = Array(text)
    var out = ""
    for (i, c) in chars.enumerated() {
      let prev: Character? = i > 0 ? chars[i - 1] : "~"
      let next: Character? = i + 1 < chars.count ? chars[i + 1] : "~"
      let word = { (c: Character?) in c.map { $0.isLetter || $0.isNumber } ?? false }
      switch c {
      case "\\", "*", "`":
        out += "\\" + String(c)
      case "_" where !(word(prev) && word(next)):
        out += "\\_"
      case "~" where prev == "~" || next == "~", "=" where prev == "=" || next == "=" || i == 0 || i == chars.count - 1:
        out += "\\" + String(c)
      case "[" where inLink, "]" where inLink:
        out += "\\" + String(c)
      case "<" where text[text.index(text.startIndex, offsetBy: i)...].range(of: "^</?(u>|mark)", options: .regularExpression) != nil:
        out += "\\<"
      case "[" where (String(chars[i...]) + following).contains("]("):
        out += "\\["
      case "!" where next == "[":
        out += "\\!"
      default:
        out.append(c)
      }
    }
    return out
  }
}

private extension InlineMarks {
  mutating func set(_ mark: InlineMarks, _ on: Bool) {
    if on { insert(mark) } else { remove(mark) }
  }
}

// MARK: - Merge

/// Three-way merge by lines, for a save that lost a race with an agent's write. Both sides' changes survive; where they
/// touch the same lines, the agent's lines come first and the user's follow, so nothing is dropped.
enum NoteMerge {
  private struct Hunk {
    let base: Range<Int>
    let lines: [Substring]
  }

  static func merge(base: String, ours: String, theirs: String) -> String {
    if ours == base || ours == theirs { return theirs }
    if theirs == base { return ours }
    let b = base.split(separator: "\n", omittingEmptySubsequences: false)
    let o = ours.split(separator: "\n", omittingEmptySubsequences: false)
    let t = theirs.split(separator: "\n", omittingEmptySubsequences: false)
    let mine = hunks(b, o)
    let agent = hunks(b, t)
    var out: [Substring] = []
    var position = 0
    var mi = 0
    var ai = 0
    while mi < mine.count || ai < agent.count {
      var lower = Int.max
      if mi < mine.count { lower = min(lower, mine[mi].base.lowerBound) }
      if ai < agent.count { lower = min(lower, agent[ai].base.lowerBound) }
      var upper = lower
      var groupMine: [Hunk] = []
      var groupAgent: [Hunk] = []
      var grew = true
      while grew {
        grew = false
        while mi < mine.count, touches(mine[mi].base, lower, upper) {
          upper = max(upper, mine[mi].base.upperBound)
          groupMine.append(mine[mi])
          mi += 1
          grew = true
        }
        while ai < agent.count, touches(agent[ai].base, lower, upper) {
          upper = max(upper, agent[ai].base.upperBound)
          groupAgent.append(agent[ai])
          ai += 1
          grew = true
        }
      }
      out += b[position..<lower]
      let mineLines = apply(groupMine, to: b, lower..<upper)
      let agentLines = apply(groupAgent, to: b, lower..<upper)
      if groupMine.isEmpty {
        out += agentLines
      } else if groupAgent.isEmpty || mineLines == agentLines {
        out += mineLines
      } else {
        out += agentLines + mineLines
      }
      position = upper
    }
    out += b[position...]
    return out.joined(separator: "\n")
  }

  private static func touches(_ range: Range<Int>, _ lower: Int, _ upper: Int) -> Bool {
    if lower == upper { return range.lowerBound == lower }
    return range.lowerBound < upper && (range.upperBound > lower || range.isEmpty && range.lowerBound >= lower)
  }

  private static func apply(_ hunks: [Hunk], to base: [Substring], _ range: Range<Int>) -> [Substring] {
    var out: [Substring] = []
    var position = range.lowerBound
    for hunk in hunks {
      out += base[position..<hunk.base.lowerBound]
      out += hunk.lines
      position = hunk.base.upperBound
    }
    out += base[position..<range.upperBound]
    return out
  }

  private static func hunks(_ base: [Substring], _ other: [Substring]) -> [Hunk] {
    let diff = other.difference(from: base)
    var removed = Set<Int>()
    var inserted = Set<Int>()
    for change in diff {
      switch change {
      case let .remove(offset, _, _): removed.insert(offset)
      case let .insert(offset, _, _): inserted.insert(offset)
      }
    }
    var out: [Hunk] = []
    var i = 0
    var j = 0
    while i < base.count || j < other.count {
      if (i < base.count && removed.contains(i)) || (j < other.count && inserted.contains(j)) {
        let si = i
        let sj = j
        while (i < base.count && removed.contains(i)) || (j < other.count && inserted.contains(j)) {
          if i < base.count, removed.contains(i) { i += 1 }
          if j < other.count, inserted.contains(j) { j += 1 }
        }
        out.append(Hunk(base: si..<i, lines: Array(other[sj..<j])))
      } else {
        i += 1
        j += 1
      }
    }
    return out
  }
}
