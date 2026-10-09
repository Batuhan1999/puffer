import UIKit
import UniformTypeIdentifiers

/// What a tap lands on besides text.
enum NoteHotspot {
  case checkbox(paragraphStart: Int)
  case disclosure(paragraphStart: Int)
  case attachment(AttachmentRef)
  case note(String)
  case link(URL)
}

enum TableCommand {
  case insert, rowAbove, rowBelow, columnBefore, columnAfter, deleteRow, deleteColumn
}

/// What the Aa panel shows as selected.
struct FormatState: Equatable {
  var block: NoteBlock
  var marks: InlineMarks
  var highlight: Highlight?
}

protocol NoteTextViewHost: AnyObject {
  func noteTextViewDidChange(_ view: NoteTextView)
  func noteTextViewDidChangeSelection(_ view: NoteTextView)
  func noteTextView(_ view: NoteTextView, didChangeEditing editing: Bool)
  func noteTextView(_ view: NoteTextView, open ref: AttachmentRef)
  func noteTextView(_ view: NoteTextView, paste images: [UIImage])
  func noteTextView(_ view: NoteTextView, present controller: UIViewController)
  func noteTextView(_ view: NoteTextView, openNote id: String)
  /// The user typed `>>`; the host offers notes to link and calls `insertNoteLink`.
  func noteTextView(_ view: NoteTextView, wantsNoteLinkReplacing range: NSRange)
}

/// A UITextView on TextKit 2 that edits a `NoteDocument`. Paragraph structure lives in attributes (see NoteRendering),
/// every paragraph keeps its newline, and the cursor never goes past the last one.
final class NoteTextView: UITextView, UITextViewDelegate, NSTextStorageDelegate, NSTextLayoutManagerDelegate, NSTextContentStorageDelegate {
  static let markdownType = "net.daringfireball.markdown"

  weak var host: NoteTextViewHost?
  var makeAttachment: (AttachmentRef) -> NSTextAttachment = { _ in NSTextAttachment() }
  private lazy var tapper = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))

  init() {
    super.init(frame: .zero, textContainer: nil)
    delegate = self
    textStorage.delegate = self
    textLayoutManager?.delegate = self
    (textLayoutManager?.textContentManager as? NSTextContentStorage)?.delegate = self
    textContainer.lineFragmentPadding = 0
    textContainerInset = UIEdgeInsets(top: 52, left: NoteTheme.margin, bottom: 160, right: NoteTheme.margin)
    autocapitalizationType = .sentences
    allowsEditingTextAttributes = false
    alwaysBounceVertical = true
    keyboardDismissMode = .interactive
    isFindInteractionEnabled = true
    contentInsetAdjustmentBehavior = .automatic
    backgroundColor = .systemBackground
    tintColor = NoteTheme.tint
    linkTextAttributes = [:]
    writingToolsBehavior = .complete
    allowedWritingToolsResultOptions = [.plainText]
    addGestureRecognizer(tapper)
    for direction in [UISwipeGestureRecognizer.Direction.right, .left] {
      let swipe = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
      swipe.direction = direction
      addGestureRecognizer(swipe)
    }
  }

  required init?(coder: NSCoder) { fatalError("not coded") }

  // MARK: document

  var document: NoteDocument { NoteRendering.document(textStorage) }
  var markdown: String { document.markdown }

  /// Shows `document`; `keepSelection` maps the cursor across what changed, for a reload under the user's hands.
  func load(_ document: NoteDocument, keepSelection: Bool) {
    let before = textStorage.string
    let selection = selectedRange
    textStorage.setAttributedString(NoteRendering.attributedString(document, attachment: makeAttachment))
    NoteStyler.layoutStructure(textStorage)
    selectedRange = keepSelection ? Self.mapped(selection, from: before, to: textStorage.string) : NSRange(location: 0, length: 0)
    refreshTypingAttributes()
  }

  /// A range in `old` moved to where the same text sits in `new`, by their common prefix and suffix.
  static func mapped(_ range: NSRange, from old: String, to new: String) -> NSRange {
    let a = old as NSString, b = new as NSString
    var prefix = 0
    while prefix < a.length, prefix < b.length, a.character(at: prefix) == b.character(at: prefix) { prefix += 1 }
    var suffix = 0
    while suffix < a.length - prefix, suffix < b.length - prefix, a.character(at: a.length - 1 - suffix) == b.character(at: b.length - 1 - suffix) { suffix += 1 }
    func map(_ i: Int) -> Int {
      if i <= prefix { return i }
      if i >= a.length - suffix { return i + b.length - a.length }
      return b.length - suffix
    }
    let start = min(map(range.location), max(0, b.length - 1))
    let end = max(start, min(map(NSMaxRange(range)), b.length))
    return NSRange(location: start, length: end - start)
  }

  // MARK: paragraphs

  private var plain: NSString { textStorage.string as NSString }

  func paragraph(at location: Int) -> NSRange {
    guard plain.length > 0 else { return NSRange(location: 0, length: 0) }
    return plain.paragraphRange(for: NSRange(location: min(max(0, location), plain.length - 1), length: 0))
  }

  func block(of paragraph: NSRange) -> NoteBlock {
    textStorage.block(at: NSMaxRange(paragraph) - 1)
  }

  private func content(of paragraph: NSRange) -> NSRange {
    let terminated = paragraph.length > 0 && plain.character(at: NSMaxRange(paragraph) - 1) == 10
    return NSRange(location: paragraph.location, length: paragraph.length - (terminated ? 1 : 0))
  }

  private var selectedParagraphs: [NSRange] {
    var out: [NSRange] = []
    var location = paragraph(at: selectedRange.location).location
    let end = max(NSMaxRange(selectedRange), selectedRange.location + 1)
    repeat {
      let range = paragraph(at: location)
      out.append(range)
      location = NSMaxRange(range)
    } while location < end && location < plain.length
    return out
  }

  var formatState: FormatState {
    let block = block(of: paragraph(at: selectedRange.location))
    let style = selectedRange.length == 0
      ? (typingAttributes[.noteInline] as? InlineBox)?.style ?? InlineStyle()
      : textStorage.inlineStyle(at: selectedRange.location)
    return FormatState(block: block, marks: style.marks, highlight: style.highlight)
  }

  // MARK: edits

  /// Runs an edit with one undo step that restores the whole note, then restyles and tells the host.
  private func perform(_ name: String, selection: NSRange? = nil, _ edit: (NSTextStorage) -> Void) {
    let before = NSAttributedString(attributedString: textStorage)
    let beforeSelection = selectedRange
    undoManager?.registerUndo(withTarget: self) { $0.restore(before, beforeSelection, name) }
    undoManager?.setActionName(name)
    textStorage.beginEditing()
    edit(textStorage)
    textStorage.endEditing()
    finishEdit(selection: selection)
  }

  private func restore(_ snapshot: NSAttributedString, _ selection: NSRange, _ name: String) {
    let current = NSAttributedString(attributedString: textStorage)
    let currentSelection = selectedRange
    undoManager?.registerUndo(withTarget: self) { $0.restore(current, currentSelection, name) }
    undoManager?.setActionName(name)
    textStorage.setAttributedString(snapshot)
    finishEdit(selection: selection)
  }

  private func finishEdit(selection: NSRange?) {
    ensureTerminator()
    NoteStyler.layoutStructure(textStorage)
    if let selection { selectedRange = NSRange(location: min(selection.location, max(0, textStorage.length - 1)), length: selection.length) }
    refreshTypingAttributes()
    markActiveHeading()
    host?.noteTextViewDidChange(self)
    host?.noteTextViewDidChangeSelection(self)
  }

  private func ensureTerminator() {
    guard markedTextRange == nil else { return }
    if textStorage.length == 0 || plain.character(at: textStorage.length - 1) != 10 {
      let block = textStorage.length == 0 ? NoteBlock.text(.title, quoted: false) : textStorage.block(at: textStorage.length - 1)
      let selection = selectedRange
      textStorage.append(NSAttributedString(string: "\n", attributes: NoteTheme.attributes(block, InlineStyle())))
      selectedRange = selection
    }
  }

  private func setBlocks(_ name: String, _ transform: (NoteBlock) -> NoteBlock) {
    let changes = selectedParagraphs.map { ($0, transform(block(of: $0))) }
    perform(name, selection: selectedRange) { storage in
      for (range, block) in changes { storage.addAttribute(.noteBlock, value: BlockBox(block), range: range) }
    }
  }

  func applyStyle(_ style: TextStyle) {
    let all = selectedParagraphs.allSatisfy { if case .text(style, _) = block(of: $0) { true } else { false } }
    setBlocks("Style") { all && style != .body ? .text(.body, quoted: $0.quoted) : .text(style, quoted: $0.quoted) }
  }

  func applyMono() {
    let all = selectedParagraphs.allSatisfy { block(of: $0) == .mono }
    setBlocks("Monostyled") { _ in all ? .body : .mono }
  }

  func toggleList(_ kind: ListKind) {
    func same(_ block: NoteBlock) -> Bool {
      switch (block.listKind, kind) {
      case (.checklist?, .checklist): true
      case let (current?, wanted): current == wanted
      default: false
      }
    }
    let all = selectedParagraphs.allSatisfy { same(block(of: $0)) }
    setBlocks("List") { block in
      if all { return .text(.body, quoted: block.quoted) }
      if case .checklist = kind, case let .checklist(checked)? = block.listKind { return .list(.checklist(checked: checked), indent: block.indent, quoted: block.quoted) }
      return .list(kind, indent: block.indent, quoted: block.quoted)
    }
  }

  func indent(_ delta: Int) {
    setBlocks(delta > 0 ? "Indent" : "Outdent") { $0.indented(by: delta) }
  }

  func toggleQuote() {
    let all = selectedParagraphs.allSatisfy { block(of: $0).quoted }
    setBlocks("Block Quote") { $0.quoting(!all) }
  }

  func toggleMark(_ mark: InlineMarks) {
    if selectedRange.length == 0 {
      var style = (typingAttributes[.noteInline] as? InlineBox)?.style ?? InlineStyle()
      style.marks.formSymmetricDifference(mark)
      setTypingStyle(style)
      return
    }
    let range = selectedRange
    var all = true
    textStorage.enumerateAttribute(.noteInline, in: range) { value, run, stop in
      if plain.substring(with: run) != "\n", !((value as? InlineBox)?.style.marks.contains(mark) ?? false) {
        all = false
        stop.pointee = true
      }
    }
    restyleInline("Format", range) { style in
      if all { style.marks.remove(mark) } else { style.marks.insert(mark) }
    }
  }

  func setHighlight(_ color: Highlight?) {
    if selectedRange.length == 0 {
      var style = (typingAttributes[.noteInline] as? InlineBox)?.style ?? InlineStyle()
      style.highlight = color
      setTypingStyle(style)
      return
    }
    restyleInline("Highlight", selectedRange) { $0.highlight = color }
  }

  func setLink(_ url: String?) {
    guard selectedRange.length > 0 else { return }
    restyleInline("Link", selectedRange) { $0.link = url }
  }

  private func restyleInline(_ name: String, _ range: NSRange, _ change: (inout InlineStyle) -> Void) {
    var runs: [(NSRange, InlineStyle)] = []
    textStorage.enumerateAttribute(.noteInline, in: range) { value, run, _ in
      var style = (value as? InlineBox)?.style ?? InlineStyle()
      change(&style)
      runs.append((run, style))
    }
    perform(name, selection: range) { storage in
      for (run, style) in runs { storage.addAttribute(.noteInline, value: InlineBox(style), range: run) }
    }
  }

  private func setTypingStyle(_ style: InlineStyle) {
    let block = block(of: paragraph(at: selectedRange.location))
    var attributes = NoteTheme.attributes(block, style)
    attributes[.paragraphStyle] = typingAttributes[.paragraphStyle] ?? NoteTheme.paragraphStyle(block)
    typingAttributes = attributes
    host?.noteTextViewDidChangeSelection(self)
  }

  func toggleCheck(at location: Int) {
    let range = paragraph(at: location)
    guard case let .list(.checklist(checked), indent, quoted) = block(of: range) else { return }
    perform(checked ? "Uncheck" : "Check") { storage in
      storage.addAttribute(.noteBlock, value: BlockBox(.list(.checklist(checked: !checked), indent: indent, quoted: quoted)), range: range)
    }
    UISelectionFeedbackGenerator().selectionChanged()
  }

  /// A change to the whole note as a document, such as reordering checklist items.
  func transform(_ name: String, _ change: (inout NoteDocument) -> Void) {
    var document = document
    let before = document
    change(&document)
    guard document != before else { return }
    let rendered = NoteRendering.attributedString(document, attachment: makeAttachment)
    let selection = selectedRange
    perform(name, selection: Self.mapped(selection, from: textStorage.string, to: rendered.string)) { $0.setAttributedString(rendered) }
  }

  /// Each attachment on a line of its own, after the cursor's line.
  func insertAttachments(_ refs: [AttachmentRef]) {
    guard !refs.isEmpty else { return }
    let range = selectedRange
    let current = paragraph(at: range.location)
    let currentBlock = block(of: current)
    let piece = NSMutableAttributedString()
    if range.location > current.location {
      piece.append(NSAttributedString(string: "\n", attributes: NoteTheme.attributes(currentBlock, InlineStyle())))
    }
    for ref in refs {
      let attachment = NSMutableAttributedString(attachment: makeAttachment(ref))
      attachment.addAttributes(NoteTheme.attributes(.body, InlineStyle()), range: NSRange(location: 0, length: attachment.length))
      piece.append(attachment)
      piece.append(NSAttributedString(string: "\n", attributes: NoteTheme.attributes(.body, InlineStyle())))
    }
    let after = range.location + piece.length
    perform("Attach", selection: NSRange(location: after, length: 0)) { storage in
      storage.replaceCharacters(in: range, with: piece)
      let rest = (storage.string as NSString).paragraphRange(for: NSRange(location: min(after, storage.length - 1), length: 0))
      if rest.length <= 1 { storage.addAttribute(.noteBlock, value: BlockBox(currentBlock.next), range: rest) }
    }
  }

  /// Replaces the attachment's image after its file changed, such as an edited drawing.
  func refreshAttachment(_ ref: AttachmentRef) {
    var ranges: [NSRange] = []
    textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, range, _ in
      if (value as? NoteTextAttachment)?.ref == ref { ranges.append(range) }
    }
    guard !ranges.isEmpty else { return }
    textStorage.beginEditing()
    for range in ranges { textStorage.addAttribute(.attachment, value: makeAttachment(ref), range: range) }
    textStorage.endEditing()
  }

  /// The cursor's paragraph as an index into `document.paragraphs`, and its table column.
  private var cursorPosition: (paragraph: Int, column: Int) {
    let current = paragraph(at: selectedRange.location)
    let before = plain.substring(to: current.location)
    let index = before.reduce(0) { $1 == "\n" ? $0 + 1 : $0 }
    let typed = plain.substring(with: NSRange(location: current.location, length: max(0, selectedRange.location - current.location)))
    return (index, typed.filter { $0 == "\t" }.count)
  }

  var inTable: Bool {
    if case .tableRow = block(of: paragraph(at: selectedRange.location)) { true } else { false }
  }

  func table(_ command: TableCommand) {
    let (index, column) = cursorPosition
    var landing: Int?
    transform("Table") { document in
      switch command {
      case .insert: landing = document.insertTable(after: index)
      case .rowAbove: document.addRow(at: index, below: false)
      case .rowBelow: document.addRow(at: index, below: true)
      case .columnBefore: document.addColumn(at: index, column: column, after: false)
      case .columnAfter: document.addColumn(at: index, column: column, after: true)
      case .deleteRow: document.deleteRow(at: index)
      case .deleteColumn: document.deleteColumn(at: index, column: column)
      }
    }
    if let landing {
      var location = 0
      for _ in 0..<landing { location = NSMaxRange(paragraph(at: location)) }
      selectedRange = NSRange(location: min(location, max(0, textStorage.length - 1)), length: 0)
    }
  }

  func insertNoteLink(title: String, id: String, replacing range: NSRange) {
    guard NSMaxRange(range) <= textStorage.length else { return }
    var style = textStorage.inlineStyle(at: range.location)
    style.link = NoteLink.url(id)
    let block = block(of: paragraph(at: range.location))
    let link = NSMutableAttributedString(string: title.isEmpty ? "Untitled" : title, attributes: NoteTheme.attributes(block, style))
    link.append(NSAttributedString(string: " ", attributes: NoteTheme.attributes(block, InlineStyle())))
    perform("Link to Note", selection: NSRange(location: range.location + link.length, length: 0)) { $0.replaceCharacters(in: range, with: link) }
  }

  private func insertFragment(_ fragment: NoteDocument) {
    let rendered = NSMutableAttributedString(attributedString: NoteRendering.attributedString(fragment, attachment: makeAttachment))
    if rendered.string.hasSuffix("\n") { rendered.deleteCharacters(in: NSRange(location: rendered.length - 1, length: 1)) }
    let range = selectedRange
    perform("Paste", selection: NSRange(location: range.location + rendered.length, length: 0)) { $0.replaceCharacters(in: range, with: rendered) }
  }

  // MARK: typing

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
    if replacement == "\n" { return !handleReturn(range) }
    if replacement == "\t", case .list = block(of: paragraph(at: range.location)) {
      indent(1)
      return false
    }
    if replacement == "\t", inTable {
      let current = paragraph(at: range.location)
      let rest = plain.substring(with: NSRange(location: range.location, length: NSMaxRange(content(of: current)) - range.location))
      let hop = rest.firstIndex(of: "\t").map { rest.utf16.distance(from: rest.startIndex, to: $0) + 1 } ?? rest.utf16.count + 1
      selectedRange = NSRange(location: min(range.location + hop, max(0, textStorage.length - 1)), length: 0)
      return false
    }
    if replacement == ">", range.length == 0, range.location > 0, plain.character(at: range.location - 1) == 62 {
      let start = range.location - 1
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.host?.noteTextView(self, wantsNoteLinkReplacing: NSRange(location: start, length: 2))
      }
      return true
    }
    if replacement == " ", range.length == 0, convertListShortcut(at: range.location) { return false }
    return true
  }

  /// Return continues a list, ends it on an empty item, and turns a title or heading into body text after it.
  private func handleReturn(_ range: NSRange) -> Bool {
    let current = paragraph(at: range.location)
    let block = block(of: current)
    let body = content(of: current)
    if body.length == 0, range.length == 0 {
      if case let .list(_, indent, quoted) = block {
        setBlocks("List") { _ in indent > 0 ? block.indented(by: -1) : .text(.body, quoted: quoted) }
        return true
      }
      if block.quoted || block == .mono {
        setBlocks("Style") { _ in block == .mono ? .body : block.quoting(false) }
        return true
      }
    }
    let atEnd = NSMaxRange(range) >= NSMaxRange(body)
    var next = block.next
    if !atEnd, case .text = block { next = block }
    var inserted = "\n"
    if atEnd, case .tableRow = block {
      inserted += String(repeating: "\t", count: plain.substring(with: body).filter { $0 == "\t" }.count)
    }
    let caret = range.location + inserted.count
    perform("Typing", selection: NSRange(location: caret, length: 0)) { storage in
      storage.replaceCharacters(in: range, with: NSAttributedString(string: inserted, attributes: NoteTheme.attributes(block, InlineStyle())))
      let second = (storage.string as NSString).paragraphRange(for: NSRange(location: min(range.location + 1, storage.length - 1), length: 0))
      storage.addAttribute(.noteBlock, value: BlockBox(next), range: second)
    }
    scrollRangeToVisible(selectedRange)
    return true
  }

  /// `- `, `* `, `1. ` and `[] ` at the start of a body line start a list, as in Apple Notes.
  private func convertListShortcut(at location: Int) -> Bool {
    let current = paragraph(at: location)
    guard case let .text(.body, quoted) = block(of: current), location > current.location else { return false }
    let typed = plain.substring(with: NSRange(location: current.location, length: location - current.location))
    let kind: ListKind? = switch typed {
    case "-", "–", "—": .dash
    case "*", "•": .bullet
    case "[]", "[ ]": .checklist(checked: false)
    default: typed.range(of: "^[0-9]{1,3}[.)]$", options: .regularExpression) != nil ? .number : nil
    }
    guard let kind else { return false }
    let markRange = NSRange(location: current.location, length: typed.utf16.count)
    perform("List", selection: NSRange(location: current.location, length: 0)) { storage in
      storage.replaceCharacters(in: markRange, with: "")
      let range = (storage.string as NSString).paragraphRange(for: NSRange(location: min(current.location, storage.length - 1), length: 0))
      storage.addAttribute(.noteBlock, value: BlockBox(.list(kind, indent: 0, quoted: quoted)), range: range)
    }
    return true
  }

  /// At the start of a line, Delete first removes its list mark, quote or indent, then joins it to the line above,
  /// which keeps its own style.
  override func deleteBackward() {
    let range = selectedRange
    guard range.length == 0, markedTextRange == nil else { return super.deleteBackward() }
    let current = paragraph(at: range.location)
    guard range.location == current.location else { return super.deleteBackward() }
    let block = block(of: current)
    if case let .list(_, indent, quoted) = block {
      setBlocks("List") { _ in indent > 0 ? block.indented(by: -1) : .text(.body, quoted: quoted) }
      return
    }
    if block.quoted {
      setBlocks("Block Quote") { $0.quoting(false) }
      return
    }
    guard current.location > 0 else {
      if block == .mono { setBlocks("Style") { _ in .body } }
      return
    }
    let previous = paragraph(at: current.location - 1)
    let previousBlock = self.block(of: previous)
    let newline = NSRange(location: current.location - 1, length: 1)
    perform("Delete", selection: NSRange(location: newline.location, length: 0)) { storage in
      storage.replaceCharacters(in: newline, with: "")
      let joined = (storage.string as NSString).paragraphRange(for: NSRange(location: min(newline.location, storage.length - 1), length: 0))
      storage.addAttribute(.noteBlock, value: BlockBox(previousBlock), range: joined)
    }
  }

  func textViewDidChange(_ textView: UITextView) {
    normalizeLineBreaks()
    ensureTerminator()
    NoteStyler.layoutStructure(textStorage)
    host?.noteTextViewDidChange(self)
  }

  private func normalizeLineBreaks() {
    guard markedTextRange == nil, textStorage.string.rangeOfCharacter(from: CharacterSet(charactersIn: "\r\u{2028}\u{2029}")) != nil else { return }
    let selection = selectedRange
    textStorage.beginEditing()
    for separator in ["\r\n", "\r", "\u{2028}", "\u{2029}"] {
      var found = plain.range(of: separator)
      while found.location != NSNotFound {
        textStorage.replaceCharacters(in: found, with: "\n")
        found = plain.range(of: separator)
      }
    }
    textStorage.endEditing()
    selectedRange = NSRange(location: min(selection.location, textStorage.length), length: 0)
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    let length = textStorage.length
    if selectedRange.length == 0, length > 0, selectedRange.location >= length {
      selectedRange = NSRange(location: length - 1, length: 0)
      return
    }
    refreshTypingAttributes()
    markActiveHeading()
    host?.noteTextViewDidChangeSelection(self)
  }

  /// The block of the cursor's line, and the style of the character before it on that line; links do not continue.
  func refreshTypingAttributes() {
    let location = selectedRange.location
    let current = paragraph(at: location)
    let block = block(of: current)
    var style = InlineStyle()
    if location > current.location, location <= textStorage.length {
      style = textStorage.inlineStyle(at: location - 1)
      style.link = nil
    }
    var attributes = NoteTheme.attributes(block, style)
    if textStorage.length > 0, let paragraphStyle = textStorage.attribute(.paragraphStyle, at: min(location, textStorage.length - 1), effectiveRange: nil) {
      attributes[.paragraphStyle] = paragraphStyle
    }
    typingAttributes = attributes
  }

  func textViewDidBeginEditing(_ textView: UITextView) { host?.noteTextView(self, didChangeEditing: true) }
  func textViewDidEndEditing(_ textView: UITextView) { host?.noteTextView(self, didChangeEditing: false) }

  var tableMenu: UIMenu {
    let item = { (title: String, symbol: String, command: TableCommand) in
      UIAction(title: title, image: UIImage(systemName: symbol), attributes: command == .deleteRow || command == .deleteColumn ? .destructive : []) { [weak self] _ in self?.table(command) }
    }
    return UIMenu(title: "Table", image: UIImage(systemName: "tablecells"), children: [
      item("Add Row Above", "arrow.up.to.line", .rowAbove), item("Add Row Below", "arrow.down.to.line", .rowBelow),
      item("Add Column Before", "arrow.left.to.line", .columnBefore), item("Add Column After", "arrow.right.to.line", .columnAfter),
      item("Delete Row", "trash", .deleteRow), item("Delete Column", "trash", .deleteColumn),
    ])
  }

  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    guard isEditable else { return UIMenu(children: suggestedActions) }
    guard range.length > 0 else { return UIMenu(children: suggestedActions + (inTable ? [tableMenu] : [])) }
    var extra: [UIMenuElement] = []
    if textStorage.inlineStyle(at: range.location).link != nil {
      extra.append(UIAction(title: "Remove Link", image: UIImage(systemName: "link.badge.minus")) { [weak self] _ in self?.setLink(nil) })
    } else {
      extra.append(UIAction(title: "Add Link…", image: UIImage(systemName: "link")) { [weak self] _ in self?.askForLink() })
    }
    let colors = Highlight.allCases.map { color in
      UIAction(title: NoteTheme.highlightNames[color] ?? color.rawValue, image: UIImage(systemName: "circle.fill")?.withTintColor(NoteTheme.highlight(color), renderingMode: .alwaysOriginal)) { [weak self] _ in self?.setHighlight(color) }
    }
    extra.append(UIMenu(title: "Highlight", image: UIImage(systemName: "highlighter"), children: colors + [UIAction(title: "None") { [weak self] _ in self?.setHighlight(nil) }]))
    return UIMenu(children: suggestedActions + extra)
  }

  private func askForLink() {
    let alert = UIAlertController(title: "Add Link", message: nil, preferredStyle: .alert)
    alert.addTextField { field in
      field.placeholder = "https://"
      field.keyboardType = .URL
      field.autocapitalizationType = .none
      field.text = UIPasteboard.general.hasURLs ? UIPasteboard.general.url?.absoluteString : nil
    }
    let range = selectedRange
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    alert.addAction(UIAlertAction(title: "Add", style: .default) { [weak self, weak alert] _ in
      guard let self, var link = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespaces), !link.isEmpty else { return }
      if !link.contains(":") { link = "https://" + link }
      self.selectedRange = range
      self.setLink(link)
    })
    host?.noteTextView(self, present: alert)
  }

  // MARK: pasteboard

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else { return }
    let fragment = NoteRendering.document(textStorage, in: selectedRange)
    UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: fragment.plainText, Self.markdownType: fragment.markdown]])
  }

  override func cut(_ sender: Any?) {
    guard selectedRange.length > 0, isEditable else { return }
    copy(sender)
    if let range = selectedTextRange { replace(range, withText: "") }
  }

  override func paste(_ sender: Any?) {
    guard isEditable else { return }
    let board = UIPasteboard.general
    if let markdown = board.data(forPasteboardType: Self.markdownType).flatMap({ String(data: $0, encoding: .utf8) }) ?? board.value(forPasteboardType: Self.markdownType) as? String {
      insertFragment(NoteMarkdown.parse(markdown, implicitTitle: false))
      return
    }
    if selectedRange.length > 0, let string = board.string?.trimmingCharacters(in: .whitespacesAndNewlines), !string.contains(" "),
       let url = URL(string: string), let scheme = url.scheme, ["http", "https", "mailto", "tel"].contains(scheme.lowercased()) {
      setLink(string)
      return
    }
    if !board.hasStrings, board.hasImages, let images = board.images, !images.isEmpty {
      host?.noteTextView(self, paste: images)
      return
    }
    if let string = board.string, let range = selectedTextRange {
      replace(range, withText: string.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n"))
      return
    }
    super.paste(sender)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)) { return isEditable && (UIPasteboard.general.hasStrings || UIPasteboard.general.hasImages || UIPasteboard.general.contains(pasteboardTypes: [Self.markdownType])) }
    return super.canPerformAction(action, withSender: sender)
  }

  // MARK: taps

  func hotspot(at point: CGPoint) -> NoteHotspot? {
    guard let manager = textLayoutManager, textStorage.length > 0 else { return nil }
    let inContainer = CGPoint(x: point.x - textContainerInset.left, y: point.y - textContainerInset.top)
    guard let fragment = manager.textLayoutFragment(for: inContainer) else { return nil }
    let frame = fragment.layoutFragmentFrame
    guard inContainer.y >= frame.minY, inContainer.y <= frame.maxY else { return nil }
    let start = manager.offset(from: manager.documentRange.location, to: fragment.rangeInElement.location)
    let block = textStorage.block(at: start)
    let lead = NoteTheme.leading(block)
    if isEditable, case .list(.checklist, _, _) = block, inContainer.x < lead + 2, inContainer.x > lead - NoteTheme.checkboxWidth - 12,
       let line = fragment.textLineFragments.first, inContainer.y <= frame.minY + line.typographicBounds.maxY + 6 {
      return .checkbox(paragraphStart: start)
    }
    if case .text(let style, _) = block, style != .body, inContainer.x < 0, inContainer.x > -NoteTheme.margin,
       let line = fragment.textLineFragments.first, inContainer.y <= frame.minY + line.typographicBounds.maxY {
      return .disclosure(paragraphStart: start)
    }
    guard let position = closestPosition(to: point) else { return nil }
    let index = offset(from: beginningOfDocument, to: position)
    for i in [index, index - 1] where i >= start && i < textStorage.length {
      if let link = textStorage.attribute(.noteURL, at: i, effectiveRange: nil) as? String, let id = NoteLink.noteID(link) {
        let glyph = closestPosition(to: point).flatMap { caretRect(for: $0) }
        if glyph.map({ abs($0.midY - point.y) < 30 }) ?? false { return .note(id) }
      }
    }
    for i in [index, index - 1] where i >= start && i < textStorage.length {
      if let attachment = textStorage.attribute(.attachment, at: i, effectiveRange: nil) as? NoteTextAttachment,
         inContainer.x <= lead + attachment.bounds.width + 4 {
        return .attachment(attachment.ref)
      }
    }
    if !isFirstResponder, index < textStorage.length, let link = textStorage.attribute(.noteURL, at: index, effectiveRange: nil) as? String, let url = URL(string: link) {
      return .link(url)
    }
    return nil
  }

  override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    if recognizer === tapper { return hotspot(at: recognizer.location(in: self)) != nil }
    if recognizer is UITapGestureRecognizer, hotspot(at: recognizer.location(in: self)) != nil { return false }
    return super.gestureRecognizerShouldBegin(recognizer)
  }

  /// TextKit draws custom fragments into plain views inside its canvas, and UIKit's text interactions ignore touches on
  /// views they do not know, so a tap on a line would not place the cursor. Those touches go to the text view itself.
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    guard let hit, hit !== self, hit.isDescendant(of: self), !(hit is UIControl), (hit.gestureRecognizers ?? []).isEmpty, hit.interactions.isEmpty else { return hit }
    return self
  }

  @objc private func tapped(_ recognizer: UITapGestureRecognizer) {
    switch hotspot(at: recognizer.location(in: self)) {
    case let .checkbox(start): toggleCheck(at: start)
    case let .disclosure(start): toggleCollapsed(at: start)
    case let .attachment(ref): host?.noteTextView(self, open: ref)
    case let .note(id): host?.noteTextView(self, openNote: id)
    case let .link(url): UIApplication.shared.open(url)
    case nil: break
    }
  }

  /// Swiping a list item right or left indents or outdents it, as Apple Notes does for checklists.
  @objc private func swiped(_ recognizer: UISwipeGestureRecognizer) {
    guard isEditable, let position = closestPosition(to: recognizer.location(in: self)) else { return }
    let index = offset(from: beginningOfDocument, to: position)
    let range = paragraph(at: index)
    let block = block(of: range)
    guard case .list = block else { return }
    let next = block.indented(by: recognizer.direction == .right ? 1 : -1)
    guard next != block else { return }
    perform(recognizer.direction == .right ? "Indent" : "Outdent") { $0.addAttribute(.noteBlock, value: BlockBox(next), range: range) }
  }

  // MARK: TextKit

  func textStorage(_ textStorage: NSTextStorage, didProcessEditing editedMask: NSTextStorage.EditActions, range editedRange: NSRange, changeInLength delta: Int) {
    NoteStyler.restyle(textStorage, around: editedRange)
  }

  func textContentManager(_ textContentManager: NSTextContentManager, shouldEnumerate textElement: NSTextElement, options: NSTextContentManager.EnumerationOptions = []) -> Bool {
    guard let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return true }
    return paragraph.attributedString.attribute(.noteHidden, at: 0, effectiveRange: nil) == nil
  }

  /// Folds or unfolds the section under a heading. The cursor leaves a folded section for its heading.
  func toggleCollapsed(at location: Int) {
    let heading = paragraph(at: location)
    guard block(of: heading).headingLevel != nil else { return }
    let terminator = NSRange(location: NSMaxRange(heading) - 1, length: 1)
    let collapsed = textStorage.attribute(.noteCollapsed, at: terminator.location, effectiveRange: nil) != nil
    textStorage.beginEditing()
    if collapsed { textStorage.removeAttribute(.noteCollapsed, range: terminator) } else { textStorage.addAttribute(.noteCollapsed, value: true, range: terminator) }
    textStorage.endEditing()
    NoteStyler.layoutStructure(textStorage)
    if !collapsed, selectedRange.location >= NSMaxRange(heading), textStorage.attribute(.noteHidden, at: min(selectedRange.location, textStorage.length - 1), effectiveRange: nil) != nil {
      selectedRange = NSRange(location: terminator.location, length: 0)
    }
    UISelectionFeedbackGenerator().selectionChanged()
  }

  /// The heading holding the cursor shows its chevron; the flag sits on the heading's newline only.
  private func markActiveHeading() {
    guard textStorage.length > 0 else { return }
    let current = paragraph(at: selectedRange.location)
    let wanted: Int? = block(of: current).headingLevel != nil && current.length > 0 ? NSMaxRange(current) - 1 : nil
    var marked: [Int] = []
    textStorage.enumerateAttribute(.noteActive, in: NSRange(location: 0, length: textStorage.length)) { value, range, _ in
      if value != nil { marked += Array(range.location..<NSMaxRange(range)) }
    }
    guard marked != (wanted.map { [$0] } ?? []) else { return }
    textStorage.beginEditing()
    for location in marked { textStorage.removeAttribute(.noteActive, range: NSRange(location: location, length: 1)) }
    if let wanted { textStorage.addAttribute(.noteActive, value: true, range: NSRange(location: wanted, length: 1)) }
    textStorage.endEditing()
  }

  func textLayoutManager(_ textLayoutManager: NSTextLayoutManager, textLayoutFragmentFor location: NSTextLocation, in textElement: NSTextElement) -> NSTextLayoutFragment {
    NoteLayoutFragment(textElement: textElement, range: textElement.elementRange)
  }
}
