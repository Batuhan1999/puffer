import UIKit

// The editor's text storage holds the document as semantic attributes (`noteBlock` on every character of a paragraph,
// its terminating newline included, and `noteInline` on text). Every visual attribute is derived from those by
// `NoteStyler`, so the stored note never depends on fonts or colors.

extension NSAttributedString.Key {
  static let noteBlock = NSAttributedString.Key("puffer.note.block")
  static let noteInline = NSAttributedString.Key("puffer.note.inline")
  /// Visual: a numbered item's number.
  static let noteOrdinal = NSAttributedString.Key("puffer.note.ordinal")
  /// Visual: where a tap on an explicit or detected link goes.
  static let noteURL = NSAttributedString.Key("puffer.note.url")
  /// Visual: a `#tag`.
  static let noteTag = NSAttributedString.Key("puffer.note.tag")
  /// On a heading's newline: its section is folded. Kept while the note is open, not saved.
  static let noteCollapsed = NSAttributedString.Key("puffer.note.collapsed")
  /// On every paragraph inside a folded section; TextKit skips them.
  static let noteHidden = NSAttributedString.Key("puffer.note.hidden")
  /// On the heading holding the cursor, which shows its fold chevron.
  static let noteActive = NSAttributedString.Key("puffer.note.active")
}

final class BlockBox: NSObject {
  let block: NoteBlock
  init(_ block: NoteBlock) { self.block = block }
  override func isEqual(_ object: Any?) -> Bool { (object as? BlockBox)?.block == block }
  override var hash: Int { block.hashValue }
}

final class InlineBox: NSObject {
  let style: InlineStyle
  init(_ style: InlineStyle) { self.style = style }
  override func isEqual(_ object: Any?) -> Bool { (object as? InlineBox)?.style == style }
  override var hash: Int { style.hashValue }
}

final class NoteTextAttachment: NSTextAttachment {
  let ref: AttachmentRef

  init(ref: AttachmentRef, image: UIImage, width: CGFloat) {
    self.ref = ref
    super.init(data: nil, ofType: nil)
    self.image = image
    let scale = min(1, width / max(1, image.size.width))
    bounds = CGRect(x: 0, y: 0, width: image.size.width * scale, height: image.size.height * scale)
  }

  required init?(coder: NSCoder) { fatalError("not coded") }
}

extension NSAttributedString {
  func block(at index: Int) -> NoteBlock {
    guard length > 0 else { return .text(.title, quoted: false) }
    return (attribute(.noteBlock, at: min(max(0, index), length - 1), effectiveRange: nil) as? BlockBox)?.block ?? .body
  }

  func inlineStyle(at index: Int) -> InlineStyle {
    guard length > 0 else { return InlineStyle() }
    return (attribute(.noteInline, at: min(max(0, index), length - 1), effectiveRange: nil) as? InlineBox)?.style ?? InlineStyle()
  }
}

enum NoteTheme {
  static let tint = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 1, green: 0.84, blue: 0.04, alpha: 1) : UIColor(red: 0.9, green: 0.63, blue: 0.05, alpha: 1) }
  static let margin: CGFloat = 20
  static let indentStep: CGFloat = 24
  static let markerWidth: CGFloat = 24
  static let checkboxWidth: CGFloat = 32
  static let quoteInset: CGFloat = 16
  static let monoInset: CGFloat = 10

  static func font(_ block: NoteBlock, _ style: InlineStyle = InlineStyle()) -> UIFont {
    var font: UIFont
    switch block {
    case .text(.title, _): font = scaled(.systemFont(ofSize: 28, weight: .bold), .title1)
    case .text(.heading, _): font = scaled(.systemFont(ofSize: 22, weight: .bold), .title2)
    case .text(.subheading, _): font = scaled(.systemFont(ofSize: 18, weight: .semibold), .title3)
    case .text(.body, _), .list: font = scaled(.systemFont(ofSize: 17), .body)
    case .mono: font = scaled(.monospacedSystemFont(ofSize: 15, weight: .regular), .body)
    case let .tableRow(header): font = scaled(.monospacedSystemFont(ofSize: 15, weight: header ? .semibold : .regular), .body)
    }
    if style.marks.contains(.code) { font = .monospacedSystemFont(ofSize: font.pointSize * 0.9, weight: .regular) }
    var traits = font.fontDescriptor.symbolicTraits
    if style.marks.contains(.bold) { traits.insert(.traitBold) }
    if style.marks.contains(.italic) { traits.insert(.traitItalic) }
    if traits != font.fontDescriptor.symbolicTraits, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
      font = UIFont(descriptor: descriptor, size: font.pointSize)
    }
    return font
  }

  private static func scaled(_ font: UIFont, _ style: UIFont.TextStyle) -> UIFont {
    UIFontMetrics(forTextStyle: style).scaledFont(for: font)
  }

  /// Where a paragraph's text starts; markers and quote bars draw left of it.
  static func leading(_ block: NoteBlock) -> CGFloat {
    let quote = block.quoted ? quoteInset : 0
    switch block {
    case let .list(kind, indent, _):
      let marker = if case .checklist = kind { checkboxWidth } else { markerWidth }
      return quote + CGFloat(indent) * indentStep + marker
    case .mono, .tableRow: return monoInset
    case .text: return quote
    }
  }

  static func paragraphStyle(_ block: NoteBlock, tabStops: [CGFloat] = []) -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.firstLineHeadIndent = leading(block)
    style.headIndent = leading(block)
    switch block {
    case .text(.title, _):
      style.paragraphSpacing = 6
    case .text(.heading, _), .text(.subheading, _):
      style.paragraphSpacingBefore = 4
      style.paragraphSpacing = 2
    case .mono:
      style.tailIndent = -monoInset
      style.lineHeightMultiple = 1.15
    case .tableRow:
      style.tabStops = tabStops.map { NSTextTab(textAlignment: .left, location: $0) }
      style.defaultTabInterval = 96
      style.lineHeightMultiple = 1.5
    case .text(.body, _), .list:
      style.paragraphSpacing = 3
    }
    return style
  }

  static func highlight(_ color: Highlight) -> UIColor {
    switch color {
    case .purple: .systemPurple
    case .pink: .systemPink
    case .orange: .systemOrange
    case .mint: .systemMint
    case .blue: .systemBlue
    }
  }

  static let highlightNames: [Highlight: String] = [.purple: "Purple", .pink: "Pink", .orange: "Orange", .mint: "Mint", .blue: "Blue"]

  /// Everything a run of text with this block and style needs to draw, semantic attributes included.
  static func attributes(_ block: NoteBlock, _ style: InlineStyle) -> [NSAttributedString.Key: Any] {
    var out: [NSAttributedString.Key: Any] = [
      .noteBlock: BlockBox(block), .noteInline: InlineBox(style), .font: font(block, style),
      .foregroundColor: UIColor.label, .paragraphStyle: paragraphStyle(block),
    ]
    if style.marks.contains(.underline) { out[.underlineStyle] = NSUnderlineStyle.single.rawValue }
    if style.marks.contains(.strike) { out[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    if style.marks.contains(.code) { out[.backgroundColor] = UIColor.tertiarySystemFill }
    if let color = style.highlight {
      out[.backgroundColor] = highlight(color).withAlphaComponent(0.22)
      out[.foregroundColor] = UIColor { traits in
        let base = highlight(color).resolvedColor(with: traits)
        var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        base.getHue(&h, saturation: &s, brightness: &b, alpha: &a)
        return traits.userInterfaceStyle == .dark ? UIColor(hue: h, saturation: s * 0.5, brightness: 1, alpha: 1) : UIColor(hue: h, saturation: min(1, s * 1.1), brightness: b * 0.62, alpha: 1)
      }
    }
    if let link = style.link {
      out[.foregroundColor] = tint
      out[.underlineStyle] = NSUnderlineStyle.single.rawValue
      out[.noteURL] = link
    }
    return out
  }
}

enum NoteStyler {
  private static let visualKeys: [NSAttributedString.Key] = [
    .font, .foregroundColor, .backgroundColor, .underlineStyle, .strikethroughStyle, .paragraphStyle, .noteURL, .noteTag,
  ]
  private static let detector = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
  private static let tagPattern = try! NSRegularExpression(pattern: "(?<![\\p{L}\\p{N}_#/])#[\\p{L}\\p{N}_-]*\\p{L}[\\p{L}\\p{N}_-]*")

  /// Restyles every paragraph `range` touches: one block per paragraph (its newline's), then fonts and colors.
  static func restyle(_ storage: NSTextStorage, around range: NSRange) {
    let text = storage.string as NSString
    guard text.length > 0 else { return }
    let start = text.paragraphRange(for: NSRange(location: min(range.location, text.length - 1), length: 0)).location
    let endProbe = min(NSMaxRange(range), text.length - 1)
    let end = NSMaxRange(text.paragraphRange(for: NSRange(location: max(start, endProbe), length: 0)))
    var location = start
    while location < end {
      let paragraph = text.paragraphRange(for: NSRange(location: location, length: 0))
      style(storage, paragraph)
      location = NSMaxRange(paragraph)
    }
  }

  private static func style(_ storage: NSTextStorage, _ paragraph: NSRange) {
    let block = storage.block(at: NSMaxRange(paragraph) - 1)
    let tabStops = (storage.attribute(.paragraphStyle, at: NSMaxRange(paragraph) - 1, effectiveRange: nil) as? NSParagraphStyle)?.tabStops.map(\.location) ?? []
    for key in visualKeys { storage.removeAttribute(key, range: paragraph) }
    storage.addAttribute(.noteBlock, value: BlockBox(block), range: paragraph)
    storage.enumerateAttribute(.noteInline, in: paragraph) { value, run, _ in
      let style = (value as? InlineBox)?.style ?? InlineStyle()
      var attributes = NoteTheme.attributes(block, style)
      attributes[.paragraphStyle] = NoteTheme.paragraphStyle(block, tabStops: tabStops)
      storage.addAttributes(attributes, range: run)
    }
    guard block != .mono else { return }
    let string = storage.string
    for match in detector.matches(in: string, range: paragraph) {
      guard let url = match.url, storage.inlineStyle(at: match.range.location).link == nil else { continue }
      storage.addAttributes([.foregroundColor: NoteTheme.tint, .underlineStyle: NSUnderlineStyle.single.rawValue, .noteURL: url.absoluteString], range: match.range)
    }
    for match in tagPattern.matches(in: string, range: paragraph) where !storage.inlineStyle(at: match.range.location).marks.contains(.code) {
      storage.addAttributes([.foregroundColor: NoteTheme.tint, .noteTag: (string as NSString).substring(with: match.range)], range: match.range)
    }
  }

  /// Numbers lists and sizes table columns across the whole note; touches only paragraphs whose value changed.
  static func layoutStructure(_ storage: NSTextStorage) {
    let text = storage.string as NSString
    var paragraphs: [(range: NSRange, block: NoteBlock)] = []
    var location = 0
    while location < text.length {
      let range = text.paragraphRange(for: NSRange(location: location, length: 0))
      paragraphs.append((range, storage.block(at: NSMaxRange(range) - 1)))
      location = NSMaxRange(range)
    }
    storage.beginEditing()
    defer { storage.endEditing() }
    var foldedLevel: Int?
    for (range, block) in paragraphs {
      let level = block.headingLevel
      if let folded = foldedLevel, level.map({ $0 <= folded }) ?? false { foldedLevel = nil }
      let hidden = foldedLevel != nil
      if hidden != (storage.attribute(.noteHidden, at: range.location, effectiveRange: nil) != nil) {
        if hidden { storage.addAttribute(.noteHidden, value: true, range: range) } else { storage.removeAttribute(.noteHidden, range: range) }
      }
      if foldedLevel == nil, let level, storage.attribute(.noteCollapsed, at: NSMaxRange(range) - 1, effectiveRange: nil) != nil {
        foldedLevel = level
      }
    }
    var counters: [Int] = []
    for (range, block) in paragraphs {
      var ordinal: Int?
      if case let .list(kind, indent, _) = block {
        if counters.count > indent + 1 { counters.removeLast(counters.count - indent - 1) }
        while counters.count < indent + 1 { counters.append(0) }
        if case .number = kind {
          counters[indent] += 1
          ordinal = counters[indent]
        } else {
          counters[indent] = 0
        }
      } else {
        counters = []
      }
      let current = storage.attribute(.noteOrdinal, at: range.location, effectiveRange: nil) as? Int
      if current != ordinal {
        if let ordinal { storage.addAttribute(.noteOrdinal, value: ordinal, range: range) } else { storage.removeAttribute(.noteOrdinal, range: range) }
      }
    }
    var index = 0
    while index < paragraphs.count {
      guard case .tableRow = paragraphs[index].block else {
        index += 1
        continue
      }
      var rows: [NSRange] = []
      while index < paragraphs.count, case .tableRow = paragraphs[index].block {
        rows.append(paragraphs[index].range)
        index += 1
      }
      let stops = tabStops(storage, rows)
      for row in rows {
        let current = (storage.attribute(.paragraphStyle, at: row.location, effectiveRange: nil) as? NSParagraphStyle)?.tabStops.map(\.location) ?? []
        guard current != stops else { continue }
        storage.enumerateAttribute(.paragraphStyle, in: row) { value, run, _ in
          guard let style = (value as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle else { return }
          style.tabStops = stops.map { NSTextTab(textAlignment: .left, location: $0) }
          storage.addAttribute(.paragraphStyle, value: style, range: run)
        }
      }
    }
  }

  private static func tabStops(_ storage: NSTextStorage, _ rows: [NSRange]) -> [CGFloat] {
    var widths: [CGFloat] = []
    for row in rows {
      let line = storage.attributedSubstring(from: row)
      var column = 0
      var cellStart = 0
      let string = line.string as NSString
      for i in 0...string.length {
        let end = i == string.length || string.character(at: i) == 9 || string.character(at: i) == 10
        guard end else { continue }
        let width = line.attributedSubstring(from: NSRange(location: cellStart, length: i - cellStart)).size().width
        if widths.count <= column { widths.append(0) }
        widths[column] = max(widths[column], ceil(width) + 20)
        column += 1
        cellStart = i + 1
        if i < string.length, string.character(at: i) == 10 { break }
      }
    }
    // One stop per column end; the last one is the table's right edge, where no text follows.
    var stops: [CGFloat] = []
    var x = NoteTheme.monoInset
    for width in widths {
      x += max(56, width)
      stops.append(x)
    }
    return stops
  }
}

enum NoteRendering {
  /// Each paragraph ends with a newline, the last one too, so even an empty last line keeps its block.
  static func attributedString(_ document: NoteDocument, attachment: (AttachmentRef) -> NSTextAttachment) -> NSAttributedString {
    let out = NSMutableAttributedString()
    for paragraph in document.paragraphs {
      let box = BlockBox(paragraph.block)
      for inline in paragraph.inlines {
        switch inline {
        case let .text(text, style):
          let clean = text.replacingOccurrences(of: "\u{FFFC}", with: "")
          out.append(NSAttributedString(string: clean, attributes: [.noteBlock: box, .noteInline: InlineBox(style)]))
        case let .attachment(ref):
          let piece = NSMutableAttributedString(attachment: attachment(ref))
          piece.addAttributes([.noteBlock: box, .noteInline: InlineBox(InlineStyle())], range: NSRange(location: 0, length: piece.length))
          out.append(piece)
        }
      }
      out.append(NSAttributedString(string: "\n", attributes: [.noteBlock: box, .noteInline: InlineBox(InlineStyle())]))
    }
    return out
  }

  static func document(_ text: NSAttributedString, in range: NSRange? = nil) -> NoteDocument {
    let string = text.string as NSString
    let whole = range ?? NSRange(location: 0, length: string.length)
    var paragraphs: [NoteParagraph] = []
    var location = whole.location
    while location < NSMaxRange(whole) {
      let paragraph = string.paragraphRange(for: NSRange(location: location, length: 0))
      let terminated = string.character(at: NSMaxRange(paragraph) - 1) == 10
      let contentEnd = NSMaxRange(paragraph) - (terminated ? 1 : 0)
      let content = NSIntersectionRange(NSRange(location: paragraph.location, length: contentEnd - paragraph.location), whole)
      let block = text.block(at: NSMaxRange(paragraph) - 1)
      var inlines: [NoteInline] = []
      text.enumerateAttributes(in: content) { attributes, run, _ in
        if let attachment = attributes[.attachment] as? NoteTextAttachment {
          for _ in 0..<run.length { inlines.append(.attachment(attachment.ref)) }
          return
        }
        let piece = string.substring(with: run).replacingOccurrences(of: "\u{FFFC}", with: "")
        guard !piece.isEmpty else { return }
        let style = (attributes[.noteInline] as? InlineBox)?.style ?? InlineStyle()
        if case let .text(previous, previousStyle)? = inlines.last, previousStyle == style {
          inlines[inlines.count - 1] = .text(previous + piece, style)
        } else {
          inlines.append(.text(piece, style))
        }
      }
      paragraphs.append(NoteParagraph(block: block, inlines: inlines))
      location = NSMaxRange(paragraph)
    }
    return NoteDocument(paragraphs: paragraphs)
  }

  /// For PDF: list marks and checkboxes become characters, colors resolve for paper.
  static func printable(_ document: NoteDocument, attachment: (AttachmentRef) -> NSTextAttachment) -> NSAttributedString {
    let light = UITraitCollection(userInterfaceStyle: .light)
    let out = NSMutableAttributedString()
    var numbers: [Int: Int] = [:]
    for paragraph in document.paragraphs {
      let block = paragraph.block
      var prefix = block.quoted ? "▎ " : ""
      if case let .list(kind, indent, _) = block {
        numbers = numbers.filter { $0.key <= indent }
        let mark: String
        switch kind {
        case .bullet: mark = "•"
        case .dash: mark = "–"
        case .number:
          numbers[indent] = (numbers[indent] ?? 0) + 1
          mark = "\(numbers[indent]!)."
        case let .checklist(checked): mark = checked ? "☑" : "☐"
        }
        prefix += String(repeating: "    ", count: indent) + mark + " "
      } else {
        numbers = [:]
      }
      let plainBlock: NoteBlock = if case .list = block { .body } else { block.quoting(false) }
      var base = NoteTheme.attributes(plainBlock, InlineStyle())
      base[.foregroundColor] = UIColor.label.resolvedColor(with: light)
      out.append(NSAttributedString(string: prefix, attributes: base))
      let body = attributedString(NoteDocument(paragraphs: [NoteParagraph(block: plainBlock, inlines: paragraph.inlines)]), attachment: attachment)
      let styled = NSMutableAttributedString(attributedString: body)
      styled.enumerateAttribute(.noteInline, in: NSRange(location: 0, length: styled.length)) { value, run, _ in
        var attributes = NoteTheme.attributes(plainBlock, (value as? InlineBox)?.style ?? InlineStyle())
        for (key, color) in attributes { if let color = color as? UIColor { attributes[key] = color.resolvedColor(with: light) } }
        styled.addAttributes(attributes, range: run)
      }
      out.append(styled)
    }
    return out
  }
}
