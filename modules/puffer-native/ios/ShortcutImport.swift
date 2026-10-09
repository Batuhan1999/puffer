import Foundation
import UIKit
import UniformTypeIdentifiers

/// One item a Shortcut handed to Sync Notes to Puffer or Add to Puffer, as App Intents delivered it. Shortcuts turns
/// text into a .txt file named after its first line and rich text into an .html file; a text parameter gets plain text
/// without formatting, and a rich text (`AttributedString`) parameter gets nothing.
public enum ShortcutInput: Sendable {
  /// `type` is the UTType identifier Shortcuts gave the file, if any.
  case file(name: String, type: String?, data: Data)
  case text(String)
}

/// Why an item did not become a note. The run goes on without it.
enum ShortcutSkip: String, Error, CaseIterable, Sendable {
  case unreadable
  case empty
}

/// The text formats a file can carry, by how it becomes Markdown.
enum ShortcutTextFormat: Sendable {
  case plain
  case html
  case rtf
  case rtfd

  init(_ type: UTType?) {
    guard let type else {
      self = .plain
      return
    }
    if type.conforms(to: .html) {
      self = .html
    } else if type.conforms(to: .rtf) {
      self = .rtf
    } else if type.conforms(to: .rtfd) || type.conforms(to: .flatRTFD) {
      self = .rtfd
    } else {
      self = .plain
    }
  }
}

enum ShortcutImport {
  /// Parses every item, saves the notes in one transaction and returns the dialog Shortcuts shows. Never throws:
  /// a bad item is skipped and a store error becomes the dialog.
  static func run(_ inputs: [ShortcutInput], extra: [NoteInput], source: String, folder: String?) async -> String {
    let start = Date()
    var notes = extra
    var skipped: [ShortcutSkip: Int] = [:]
    for input in inputs {
      switch note(input) {
      case let .success(note): notes.append(note)
      case let .failure(reason): skipped[reason, default: 0] += 1
      }
    }
    logReceived(inputs, extra: extra.count, skipped: skipped)
    let parsedMs = Int(Date().timeIntervalSince(start) * 1000)
    guard !(inputs.isEmpty && extra.isEmpty) else {
      pufferLog.notice("shortcut import: received 0 items")
      return "Puffer received 0 notes. In Find Notes, choose All Notes, add no filter and turn Limit off, then pass its Notes to this action."
    }
    let skippedCount = skipped.values.reduce(0, +)
    let report: NotesReport
    do {
      report = notes.isEmpty ? NotesReport() : try await NoteImport.fromShortcut(notes, source: source, folder: folder)
    } catch {
      pufferLog.error("shortcut import failed after \(Int(Date().timeIntervalSince(start) * 1000)) ms: \(error.localizedDescription, privacy: .public)")
      return "Puffer could not save the notes, so nothing changed: \(error.localizedDescription)"
    }
    pufferLog.notice("shortcut import: \(notes.count) notes saved, parse \(parsedMs) ms, total \(Int(Date().timeIntervalSince(start) * 1000)) ms")
    return summary(report, skipped: skippedCount)
  }

  static func summary(_ report: NotesReport, skipped: Int) -> String {
    let counts = [
      (report.added, "added"), (report.updated, "updated"), (report.kept, "kept as edited in Puffer"),
      (report.unchanged, "unchanged"), (skipped, "skipped"),
    ].filter { $0.0 > 0 }.map { "\($0.0.formatted()) \($0.1)" }
    let search = report.added + report.updated > 0 ? " Search catches up in the background." : ""
    return "Puffer: \(counts.joined(separator: ", ")).\(search)"
  }

  static func note(_ input: ShortcutInput) -> Result<NoteInput, ShortcutSkip> {
    switch input {
    case let .text(text):
      return note(title: nil, markdown: text)
    case let .file(name, type, data):
      let utType = type.flatMap(UTType.init) ?? UTType(filenameExtension: (name as NSString).pathExtension)
      guard let markdown = markdown(data, format: ShortcutTextFormat(utType)) else { return .failure(.unreadable) }
      return note(title: (name as NSString).deletingPathExtension, markdown: markdown)
    }
  }

  private static func note(title fileName: String?, markdown: String) -> Result<NoteInput, ShortcutSkip> {
    let text = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return .failure(.empty) }
    let own = NoteText.title(text)
    let title = fileName.flatMap { namesFirstLine($0, own) ? nil : $0 } ?? own
    return .success(NoteInput(title: title, text: text, created: nil, modified: nil))
  }

  /// Shortcuts names a file after the note's first line, possibly shortened, with Markdown marks kept and characters a
  /// filename cannot hold replaced. Such a name is not a title of its own: the text's first line is, whole.
  static func namesFirstLine(_ fileName: String, _ firstLine: String) -> Bool {
    let letters = { (text: String) in String(text.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains)) }
    let name = letters(NoteText.plain(Substring(fileName)))
    return name.isEmpty || letters(firstLine).hasPrefix(name)
  }

  private static func markdown(_ data: Data, format: ShortcutTextFormat) -> String? {
    switch format {
    case .plain: return decode(data)
    case .html: return decode(data).map(HTMLMarkdown.markdown)
    case .rtf: return attributed(data, .rtf).map(RichMarkdown.markdown)
    case .rtfd: return attributed(data, .rtfd).map(RichMarkdown.markdown)
    }
  }

  private static func attributed(_ data: Data, _ type: NSAttributedString.DocumentType) -> NSAttributedString? {
    try? NSAttributedString(data: data, options: [.documentType: type], documentAttributes: nil)
  }

  /// UTF-8, or UTF-16 with a byte order mark. Anything else is not text.
  private static func decode(_ data: Data) -> String? {
    if let text = String(data: data, encoding: .utf8) { return text }
    guard data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) else { return nil }
    return String(data: data, encoding: .utf16)
  }

  /// Counts and type identifiers only; never note text or titles.
  private static func logReceived(_ inputs: [ShortcutInput], extra: Int, skipped: [ShortcutSkip: Int]) {
    var files = 0, texts = 0
    var types: Set<String> = []
    for input in inputs {
      switch input {
      case let .file(name, type, _):
        files += 1
        types.insert("\(type ?? "none")(.\((name as NSString).pathExtension))")
      case .text:
        texts += 1
      }
    }
    let reasons = ShortcutSkip.allCases.compactMap { reason in skipped[reason].map { "\(reason.rawValue) \($0)" } }
    pufferLog.notice("""
      shortcut import received: \(files) files, \(texts) texts, \(extra) from fields; \
      file types \(types.sorted().joined(separator: ", "), privacy: .public); \
      skipped \(reasons.isEmpty ? "none" : reasons.joined(separator: ", "), privacy: .public)
      """)
  }
}

/// RTF and RTFD to Markdown, one paragraph per line: headings from font size against the body font, lists and
/// checklists from text lists, and bold, italic, strikethrough, code and links inside a line. Attachments become a placeholder, as images do in a Markdown import.
enum RichMarkdown {
  enum Block: Equatable {
    case paragraph
    case heading(Int)
    case item(depth: Int, mark: Mark)
  }

  enum Mark: Equatable {
    case bullet
    case number
    case unchecked
    case checked

    var ordered: Bool { self == .number }
  }

  struct Inline: Equatable {
    var bold = false
    var italic = false
    var strike = false
    var code = false
    var link: String?
  }

  static let attachment = "[Image not imported]"

  static func markdown(_ text: NSAttributedString) -> String {
    let string = text.string as NSString
    let body = bodySize(text)
    var lines: [String] = []
    /// The next number per list depth, while numbered items continue.
    var numbers: [Int] = []
    for range in paragraphs(string) {
      let attributes = range.length > 0 ? text.attributes(at: range.location, effectiveRange: nil) : [:]
      var (block, prefix) = blockOf(attributes, text: string, range: range, body: body)
      var content = NSRange(location: range.location + prefix, length: range.length - prefix)
      if let (mark, length) = checkbox(string.substring(with: content)) {
        let depth = if case let .item(depth, _) = block { depth } else { 1 }
        block = .item(depth: depth, mark: mark)
        content = NSRange(location: content.location + length, length: content.length - length)
      }
      let isHeading = if case .heading = block { true } else { false }
      let inline = runs(text, string: string, range: content, heading: isHeading)
      switch block {
      case .paragraph:
        numbers = []
        lines.append(inline)
      case let .heading(level):
        numbers = []
        lines.append(String(repeating: "#", count: level) + " " + inline)
      case let .item(depth, mark):
        numbers = Array(numbers.prefix(depth))
        while numbers.count < depth { numbers.append(1) }
        let marker = switch mark {
        case .bullet: "- "
        case .number: "\(numbers[depth - 1]). "
        case .unchecked: "- [ ] "
        case .checked: "- [x] "
        }
        if mark.ordered { numbers[depth - 1] += 1 }
        lines.append(String(repeating: "  ", count: depth - 1) + marker + inline)
      }
    }
    return lines.joined(separator: "\n")
  }

  /// Paragraph ranges without their terminators, empty lines included.
  private static func paragraphs(_ string: NSString) -> [NSRange] {
    var ranges: [NSRange] = []
    var start = 0
    var index = 0
    while index < string.length {
      let unit = string.character(at: index)
      if unit == 0x0A || unit == 0x0D || unit == 0x2028 || unit == 0x2029 {
        ranges.append(NSRange(location: start, length: index - start))
        if unit == 0x0D, index + 1 < string.length, string.character(at: index + 1) == 0x0A { index += 1 }
        start = index + 1
      }
      index += 1
    }
    ranges.append(NSRange(location: start, length: string.length - start))
    return ranges
  }

  /// The block a paragraph is, and how many UTF-16 units of list marker text (RTF writes "\t•\t") lead it.
  private static func blockOf(_ attributes: [NSAttributedString.Key: Any], text: NSString, range: NSRange, body: CGFloat?) -> (Block, Int) {
    if let lists = (attributes[.paragraphStyle] as? NSParagraphStyle)?.textLists, let list = lists.last {
      let format = list.markerFormat
      let mark: Mark = switch format {
      case .box: .unchecked
      case .check: .checked
      case .decimal, .lowercaseAlpha, .uppercaseAlpha, .lowercaseRoman, .uppercaseRoman, .lowercaseLatin, .uppercaseLatin,
           .octal, .lowercaseHexadecimal, .uppercaseHexadecimal: .number
      default: .bullet
      }
      return (.item(depth: lists.count, mark: mark), markerLength(text.substring(with: range)))
    }
    if let body, let level = headingLevel(attributes, body: body) { return (.heading(level), 0) }
    return (.paragraph, 0)
  }

  /// "\t•\t" or "\t12.\t" before the text of an RTF list item.
  private static func markerLength(_ line: String) -> Int {
    let units = Array(line.utf16)
    var index = 0
    while index < units.count, units[index] == 0x09 { index += 1 }
    let markerStart = index
    while index < units.count, units[index] != 0x09, index - markerStart <= 8 { index += 1 }
    guard index < units.count, units[index] == 0x09, index > markerStart else { return 0 }
    return index + 1
  }

  private static let checkboxes: [(String, Mark)] = [
    ("[ ] ", .unchecked), ("[x] ", .checked), ("[X] ", .checked),
    ("☐ ", .unchecked), ("□ ", .unchecked), ("◻ ", .unchecked), ("☑ ", .checked), ("☒ ", .checked), ("✓ ", .checked),
    ("✔ ", .checked), ("✅ ", .checked),
  ]

  /// A checkbox written as text at the start of a line, and its length in UTF-16 units.
  private static func checkbox(_ line: String) -> (Mark, Int)? {
    checkboxes.first { line.hasPrefix($0.0) }.map { ($0.1, $0.0.utf16.count) }
  }

  /// The most common font size, by characters: what a heading is measured against.
  private static func bodySize(_ text: NSAttributedString) -> CGFloat? {
    var sizes: [CGFloat: Int] = [:]
    text.enumerateAttribute(.font, in: NSRange(location: 0, length: text.length)) { value, range, _ in
      if let font = value as? UIFont { sizes[font.pointSize.rounded(), default: 0] += range.length }
    }
    return sizes.max { $0.value < $1.value }?.key
  }

  private static func headingLevel(_ attributes: [NSAttributedString.Key: Any], body: CGFloat) -> Int? {
    guard let font = attributes[.font] as? UIFont else { return nil }
    let ratio = font.pointSize / body
    if ratio >= 1.45 { return 1 }
    if ratio >= 1.2 { return 2 }
    if ratio >= 1.08, font.fontDescriptor.symbolicTraits.contains(.traitBold) { return 3 }
    return nil
  }

  private static func inline(_ attributes: [NSAttributedString.Key: Any], heading: Bool) -> Inline {
    var style = Inline()
    if let traits = (attributes[.font] as? UIFont)?.fontDescriptor.symbolicTraits {
      style.bold = traits.contains(.traitBold)
      style.italic = traits.contains(.traitItalic)
      style.code = traits.contains(.traitMonoSpace)
    }
    if let raw = (attributes[.inlinePresentationIntent] as? NSNumber)?.uintValue {
      let intent = InlinePresentationIntent(rawValue: raw)
      style.bold = style.bold || intent.contains(.stronglyEmphasized)
      style.italic = style.italic || intent.contains(.emphasized)
      style.strike = intent.contains(.strikethrough)
      style.code = style.code || intent.contains(.code)
    }
    if let strike = attributes[.strikethroughStyle] as? Int, strike != 0 { style.strike = true }
    switch attributes[.link] {
    case let url as URL: style.link = url.absoluteString
    case let string as String: style.link = string
    default: break
    }
    if heading { style.bold = false }
    return style
  }

  /// The line's text with inline marks, merging neighbouring runs that look the same.
  private static func runs(_ text: NSAttributedString, string: NSString, range: NSRange, heading: Bool) -> String {
    guard range.length > 0 else { return "" }
    var line = ""
    var pending = ""
    var style = Inline()
    text.enumerateAttributes(in: range) { attributes, run, _ in
      let next = inline(attributes, heading: heading)
      let piece = string.substring(with: run).replacingOccurrences(of: "\u{FFFC}", with: attachment)
      if next == style {
        pending += piece
      } else {
        line += wrap(pending, style)
        pending = piece
        style = next
      }
    }
    return line + wrap(pending, style)
  }

  /// Marks hug the text: "**bold** " rather than "**bold **", which Markdown would not read as bold.
  static func wrap(_ text: String, _ style: Inline) -> String {
    let core = text.trimmingCharacters(in: .whitespaces)
    guard !core.isEmpty, style != Inline() else { return text }
    let lead = text.prefix { $0 == " " || $0 == "\t" }
    let trail = String(text.reversed().prefix { $0 == " " || $0 == "\t" })
    var marked = core
    if style.code { marked = "`\(marked)`" }
    if style.strike { marked = "~~\(marked)~~" }
    if style.italic { marked = "*\(marked)*" }
    if style.bold { marked = "**\(marked)**" }
    if let link = style.link { marked = "[\(marked)](\(link))" }
    return lead + marked + trail
  }
}

/// A small HTML tag scanner to Markdown, for notes Shortcuts hands over as HTML. NSAttributedString's HTML importer
/// runs WebKit on the main thread, tens of milliseconds per note, too slow for thousands of notes. Apple Notes writes
/// one `<div>` per line, so block tags end a line and `<p>` adds a blank one.
struct HTMLMarkdown {
  private struct List {
    let ordered: Bool
    var next = 1
    var width = 2
  }

  private var out = ""
  /// Opening marks not written yet: they go right before the next visible character, so empty spans vanish.
  private var pending = ""
  private var lists: [List] = []
  private var links: [String?] = []
  private var heading = false
  private var pre = 0
  private var cell = 0
  private var cells = 0
  private var rows = 0

  static func markdown(_ html: String) -> String {
    var writer = HTMLMarkdown()
    writer.scan(Array(html.unicodeScalars))
    return writer.out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static let skipped: Set<String> = ["head", "style", "script", "title"]

  private mutating func scan(_ scalars: [Unicode.Scalar]) {
    var index = 0
    var text = ""
    while index < scalars.count {
      let scalar = scalars[index]
      guard scalar == "<" else {
        text.unicodeScalars.append(scalar)
        index += 1
        continue
      }
      write(Self.entities(text))
      text = ""
      if matches(scalars, at: index, "<!--") {
        index = find(scalars, "-->", from: index + 4).map { $0 + 3 } ?? scalars.count
        continue
      }
      guard let end = find(scalars, ">", from: index + 1) else { break }
      let tag = Tag(String(String.UnicodeScalarView(scalars[(index + 1) ..< end])))
      index = end + 1
      if !tag.closing, Self.skipped.contains(tag.name) {
        index = find(scalars, "</\(tag.name)", from: index).flatMap { find(scalars, ">", from: $0) }.map { $0 + 1 } ?? scalars.count
        continue
      }
      handle(tag)
    }
    write(Self.entities(text))
  }

  private struct Tag {
    let name: String
    let closing: Bool
    let raw: String

    init(_ raw: String) {
      self.raw = raw
      closing = raw.hasPrefix("/")
      name = String(raw.drop { $0 == "/" }.prefix { $0.isLetter || $0.isNumber }).lowercased()
    }

    func attribute(_ key: String) -> String? {
      guard let range = raw.range(of: "\(key)=", options: .caseInsensitive) else { return nil }
      let rest = raw[range.upperBound...]
      guard let quote = rest.first, quote == "\"" || quote == "'" else {
        return String(rest.prefix { !$0.isWhitespace && $0 != ">" && $0 != "/" })
      }
      return String(rest.dropFirst().prefix { $0 != quote })
    }

    func has(_ word: String) -> Bool {
      raw.range(of: word, options: .caseInsensitive) != nil
    }
  }

  private mutating func handle(_ tag: Tag) {
    switch (tag.name, tag.closing) {
    case ("br", _):
      cell > 0 ? write(" ") : newline()
    case ("div", _), ("hr", _), ("blockquote", _):
      cell > 0 ? write(" ") : lineStart()
    case ("p", false):
      cell > 0 ? write(" ") : lineStart()
    case ("p", true):
      if cell > 0 { return write(" ") }
      lineStart()
      out += "\n"
    case let (name, false) where name.count == 2 && name.hasPrefix("h") && name.last!.isNumber:
      lineStart()
      out += String(repeating: "#", count: min(Int(String(name.last!)) ?? 1, 6)) + " "
      heading = true
    case let (name, true) where name.count == 2 && name.hasPrefix("h") && name.last!.isNumber:
      heading = false
      lineStart()
    case ("ul", false), ("ol", false):
      lineStart()
      lists.append(List(ordered: tag.name == "ol"))
    case ("ul", true), ("ol", true):
      _ = lists.popLast()
      lineStart()
    case ("li", false):
      lineStart()
      let indent = lists.dropLast().reduce(0) { $0 + $1.width }
      var marker = "- "
      if var list = lists.popLast() {
        if list.ordered {
          marker = "\(list.next). "
          list.next += 1
        }
        list.width = marker.count
        lists.append(list)
      }
      if tag.has("unchecked") {
        marker += "[ ] "
      } else if tag.has("checked") {
        marker += "[x] "
      }
      out += String(repeating: " ", count: indent) + marker
    case ("input", false) where tag.attribute("type")?.lowercased() == "checkbox":
      let box = tag.has("checked") ? "[x] " : "[ ] "
      if out.hasSuffix("- ") || out.hasSuffix(". ") {
        out += box
      } else {
        lineStart()
        out += "- " + box
      }
    case ("b", _), ("strong", _):
      if !heading { mark("**", closing: tag.closing) }
    case ("i", _), ("em", _):
      mark("*", closing: tag.closing)
    case ("s", _), ("strike", _), ("del", _):
      mark("~~", closing: tag.closing)
    case ("tt", _), ("code", _), ("kbd", _):
      if pre == 0 { mark("`", closing: tag.closing) }
    case ("pre", false):
      lineStart()
      out += "```\n"
      pre += 1
    case ("pre", true):
      lineStart()
      out += "```\n"
      pre = max(pre - 1, 0)
    case ("a", false):
      let href = tag.attribute("href").map(Self.entities)
      links.append(href)
      if href != nil { pending += "[" }
    case ("a", true):
      guard let href = links.popLast() ?? nil else { return }
      if pending.hasSuffix("[") {
        pending.removeLast()
      } else {
        close("](\(href))")
      }
    case ("img", false):
      write(RichMarkdown.attachment)
    case ("table", false):
      lineStart()
      rows = 0
    case ("tr", false):
      lineStart()
      out += "|"
      cells = 0
    case ("tr", true):
      if rows == 0 {
        newline()
        out += "|" + String(repeating: " --- |", count: max(cells, 1))
      }
      rows += 1
      newline()
    case ("td", false), ("th", false):
      out += " "
      cell += 1
      cells += 1
    case ("td", true), ("th", true):
      cell = max(cell - 1, 0)
      trimTrailingSpaces()
      out += " |"
    default:
      break
    }
  }

  private mutating func mark(_ mark: String, closing: Bool) {
    if !closing {
      pending += mark
    } else if pending.hasSuffix(mark) {
      pending.removeLast(mark.count)
    } else {
      close(mark)
    }
  }

  /// Writes a closing mark before any whitespace the span ended with.
  private mutating func close(_ mark: String) {
    let trailing = out.reversed().prefix { $0 == " " || $0 == "\n" }
    out.removeLast(trailing.count)
    out += mark + String(trailing.reversed())
  }

  private mutating func write(_ text: String) {
    guard !text.isEmpty else { return }
    if pre > 0 {
      flush()
      out += text
      return
    }
    for character in text {
      if character.isWhitespace {
        if out.isEmpty || out.hasSuffix("\n") || out.hasSuffix(" ") { continue }
        out += " "
      } else {
        flush()
        out.append(character)
      }
    }
  }

  private mutating func flush() {
    out += pending
    pending = ""
  }

  private mutating func trimTrailingSpaces() {
    while out.hasSuffix(" ") { out.removeLast() }
  }

  private mutating func newline() {
    trimTrailingSpaces()
    out += "\n"
  }

  private mutating func lineStart() {
    if !out.isEmpty, !out.hasSuffix("\n") { newline() }
  }

  private func matches(_ scalars: [Unicode.Scalar], at index: Int, _ text: String) -> Bool {
    let needle = Array(text.unicodeScalars)
    guard index + needle.count <= scalars.count else { return false }
    return scalars[index ..< index + needle.count].elementsEqual(needle)
  }

  private func find(_ scalars: [Unicode.Scalar], _ text: String, from start: Int) -> Int? {
    let needle = Array(text.lowercased().unicodeScalars)
    guard start <= scalars.count - needle.count else { return nil }
    for index in start ... (scalars.count - needle.count) {
      var found = true
      for (offset, scalar) in needle.enumerated() where lower(scalars[index + offset]) != scalar {
        found = false
        break
      }
      if found { return index }
    }
    return nil
  }

  private func lower(_ scalar: Unicode.Scalar) -> Unicode.Scalar {
    (65 ... 90).contains(scalar.value) ? Unicode.Scalar(scalar.value + 32)! : scalar
  }

  private static let named: [String: String] = [
    "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ", "mdash": "—", "ndash": "–",
    "hellip": "…", "lsquo": "‘", "rsquo": "’", "ldquo": "“", "rdquo": "”", "bull": "•", "middot": "·", "copy": "©",
    "reg": "®", "trade": "™", "euro": "€", "times": "×", "deg": "°",
  ]

  /// `&amp;`, `&#39;`, `&#x27;` and the common named entities; an unknown one stays as written.
  static func entities(_ text: String) -> String {
    guard text.contains("&") else { return text }
    var result = ""
    var rest = Substring(text)
    while let amp = rest.firstIndex(of: "&") {
      result += rest[..<amp]
      let tail = rest[amp...]
      guard let semi = tail.prefix(12).firstIndex(of: ";") else {
        result += "&"
        rest = rest[rest.index(after: amp)...]
        continue
      }
      let name = tail[tail.index(after: amp) ..< semi]
      let decoded: String? = if name.hasPrefix("#x") || name.hasPrefix("#X") {
        UInt32(name.dropFirst(2), radix: 16).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
      } else if name.hasPrefix("#") {
        UInt32(name.dropFirst()).flatMap(Unicode.Scalar.init).map { String(Character($0)) }
      } else {
        named[String(name)]
      }
      if let decoded {
        result += decoded
        rest = rest[rest.index(after: semi)...]
      } else {
        result += "&"
        rest = rest[rest.index(after: amp)...]
      }
    }
    return result + rest
  }
}
