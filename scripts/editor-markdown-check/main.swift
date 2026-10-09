import Foundation

var failures = 0
func check(_ ok: Bool, _ label: String, _ detail: @autoclosure () -> String = "") {
  if !ok { failures += 1; print("FAIL \(label) \(detail())") }
}

func normalized(_ doc: NoteDocument) -> NoteDocument {
  var d = doc
  for p in d.paragraphs.indices {
    var out: [NoteInline] = []
    for inline in d.paragraphs[p].inlines {
      if case let .text(t, _) = inline, t.isEmpty { continue }
      if case let .text(t, s) = inline, case let .text(prev, ps)? = out.last, ps == s { out[out.count - 1] = .text(prev + t, s) } else { out.append(inline) }
    }
    d.paragraphs[p].inlines = out
  }
  return d
}

let plain = InlineStyle()
func t(_ s: String, _ marks: InlineMarks = [], highlight: Highlight? = nil, link: String? = nil) -> NoteInline {
  .text(s, InlineStyle(marks: marks, highlight: highlight, link: link))
}

let sample = """
# Groceries
Plain **bold** and *italic* and _under_ and <u>underlined</u> ~~gone~~ ==marked== <mark data-color="mint">mint</mark>
- [ ] milk
- [x] eggs
    * nested bullet
1. one
2. two
> quoted line
[site](https://example.com) and `code` and snake_case and 2 * 3 * 4
![Photo](attachment:ab12cd34.jpg)
| a | b |
| --- | --- |
| 1 | **2** |
```
let x = 1
```
"""
let doc = NoteDocument(markdown: sample)
let blocks = doc.paragraphs.map(\.block)
check(blocks[0] == .text(.title, quoted: false), "title", "\(blocks[0])")
check(doc.paragraphs[1].inlines == [t("Plain "), t("bold", .bold), t(" and "), t("italic", .italic), t(" and "), t("under", .italic), t(" and "), t("underlined", .underline), t(" "), t("gone", .strike), t(" "), t("marked", highlight: .purple), t(" "), t("mint", highlight: .mint)], "inline marks", "\(doc.paragraphs[1].inlines)")
check(blocks[2] == .list(.checklist(checked: false), indent: 0, quoted: false), "unchecked")
check(blocks[3] == .list(.checklist(checked: true), indent: 0, quoted: false), "checked")
check(blocks[4] == .list(.bullet, indent: 1, quoted: false), "nested", "\(blocks[4])")
check(blocks[5] == .list(.number, indent: 0, quoted: false), "number", "\(blocks[5])")
check(blocks[7] == .text(.body, quoted: true), "quote", "\(blocks[7])")
check(doc.paragraphs[8].inlines == [t("site", link: "https://example.com"), t(" and "), t("code", .code), t(" and snake_case and 2 * 3 * 4")], "link code literal", "\(doc.paragraphs[8].inlines)")
check(doc.paragraphs[9].inlines == [.attachment(AttachmentRef(name: "Photo", file: "ab12cd34.jpg"))], "attachment")
check(blocks[10] == .tableRow(header: true) && blocks[11] == .tableRow(header: false), "table", "\(blocks[10]) \(blocks[11])")
check(doc.paragraphs[11].inlines == [t("1\t"), t("2", .bold)], "table cells", "\(doc.paragraphs[11].inlines)")
check(blocks[12] == .mono && doc.paragraphs[12].plainText == "let x = 1", "mono")
check(doc.paragraphs.count == 13, "count", "\(doc.paragraphs.count)")

let corpus = [sample, "Title\n\nBody text\n", "", "just one line", "* a\n  * b\n    * c\n* d", "1) x\n2) y", "a\\*b *c* **d *e* f**", "***both***", "Text with trailing  \n", "**bold **x", "| x |\n|---|\n| y |\n", "> - [ ] quoted task", "#tag and # heading?\n## Heading\n### Sub\n#### Deep"]
for md in corpus {
  let c1 = NoteDocument(markdown: md).markdown
  let c2 = NoteDocument(markdown: c1).markdown
  check(c1 == c2, "fixed point", "\n--- md\n\(md)\n--- c1\n\(c1)\n--- c2\n\(c2)")
}

var rng = SystemRandomNumberGenerator()
let alphabet = Array("abcXYZ019 *_~=<>[]()`\\#-+|!.:/&\"'é😀")
func word() -> String {
  var s = ""
  for _ in 0..<Int.random(in: 1...8, using: &rng) { s.append(alphabet.randomElement(using: &rng)!) }
  return s.trimmingCharacters(in: .whitespaces).isEmpty ? "w" : s.trimmingCharacters(in: .whitespaces)
}
func randomStyle() -> InlineStyle {
  var s = InlineStyle()
  for m in [InlineMarks.bold, .italic, .underline, .strike] where Bool.random(using: &rng) && Int.random(in: 0..<3, using: &rng) == 0 { s.marks.insert(m) }
  if Int.random(in: 0..<6, using: &rng) == 0 { s.highlight = Highlight.allCases.randomElement(using: &rng) }
  if Int.random(in: 0..<8, using: &rng) == 0 { s.link = "https://x.y/" + String(Int.random(in: 0..<99, using: &rng)) }
  if Int.random(in: 0..<10, using: &rng) == 0 { s = InlineStyle(marks: .code) }
  return s
}
func randomInlines() -> [NoteInline] {
  var out: [NoteInline] = []
  for n in 0..<Int.random(in: 1...5, using: &rng) {
    if n > 0 { out.append(.text(" ", plain)) }
    if Int.random(in: 0..<15, using: &rng) == 0 { out.append(.attachment(AttachmentRef(name: "img", file: "f\(n).png"))); continue }
    var w = word()
    let style = randomStyle()
    if style.marks.contains(.code) { w = w.replacingOccurrences(of: "`", with: "") ; if w.isEmpty { w = "c" } }
    out.append(.text(w, style))
  }
  return out
}
var mismatches = 0
for _ in 0..<3000 {
  var paragraphs = [NoteParagraph(block: .text(.title, quoted: false), inlines: [.text("T" + word(), plain)])]
  for _ in 0..<Int.random(in: 0...6, using: &rng) {
    let kind = Int.random(in: 0..<6, using: &rng)
    switch kind {
    case 0: paragraphs.append(NoteParagraph(block: .text([.heading, .subheading, .body].randomElement(using: &rng)!, quoted: Bool.random(using: &rng)), inlines: randomInlines()))
    case 1:
      let prevIndent = paragraphs.last?.block.indent ?? 0
      let isList = paragraphs.last?.block.listKind != nil
      let indent = isList ? Int.random(in: 0...(prevIndent + 1), using: &rng) : 0
      paragraphs.append(NoteParagraph(block: .list([.bullet, .dash, .number, .checklist(checked: Bool.random(using: &rng))].randomElement(using: &rng)!, indent: indent, quoted: false), inlines: randomInlines()))
    case 2: paragraphs.append(NoteParagraph(block: .mono, inlines: [.text(word().replacingOccurrences(of: "`", with: "'"), plain)]))
    case 3: paragraphs.append(NoteParagraph(block: .body, inlines: []))
    default: paragraphs.append(NoteParagraph(block: .body, inlines: randomInlines()))
    }
  }
  let original = normalized(NoteDocument(paragraphs: paragraphs))
  let back = normalized(NoteDocument(markdown: original.markdown))
  if back != original {
    mismatches += 1
    if mismatches <= 5 {
      print("ROUNDTRIP MISMATCH\n--- markdown\n\(original.markdown)")
      for (a, b) in zip(original.paragraphs, back.paragraphs) where a != b { print("  want \(a)\n  got  \(b)") }
      if original.paragraphs.count != back.paragraphs.count { print("  count \(original.paragraphs.count) vs \(back.paragraphs.count)") }
    }
  }
}
check(mismatches == 0, "random round trips", "\(mismatches) of 3000")

let base = "# T\na\nb\nc"
check(NoteMerge.merge(base: base, ours: "# T\na\nb2\nc", theirs: "# T\na\nb\nc\nagent") == "# T\na\nb2\nc\nagent", "disjoint", NoteMerge.merge(base: base, ours: "# T\na\nb2\nc", theirs: "# T\na\nb\nc\nagent"))
check(NoteMerge.merge(base: base, ours: "# T\na\nmine\nc", theirs: "# T\na\nagent\nc") == "# T\na\nagent\nmine\nc", "same line keeps both")
check(NoteMerge.merge(base: base, ours: base, theirs: "x") == "x", "ours unchanged")
check(NoteMerge.merge(base: base, ours: "# T\nnew\na\nb\nc", theirs: "# T\na\nb\nc") == "# T\nnew\na\nb\nc", "theirs unchanged")
check(NoteMerge.merge(base: base, ours: "# T\na\nb\nc\nmine", theirs: "# T\na\nb\nc\nagent") == "# T\na\nb\nc\nagent\nmine", "both append")
check(NoteMerge.merge(base: base, ours: "# T 2\na\nb\nc", theirs: "# T\na\nb\nc2") == "# T 2\na\nb\nc2", "far apart")
check(NoteMerge.merge(base: "", ours: "typed", theirs: "agent wrote") == "agent wrote\ntyped", "empty base")

var list = NoteDocument(markdown: "# L\n- [x] a\n- [ ] b\n- [x] c\n- [ ] d\ntext\n- [x] e\n- [ ] f")
list.moveCheckedToBottom()
check(list.markdown == "# L\n- [ ] b\n- [ ] d\n- [x] a\n- [x] c\ntext\n- [ ] f\n- [x] e", "move checked", list.markdown)
list.uncheckAll()
check(!list.markdown.contains("[x]"), "uncheck all", list.markdown)
check(NoteMarkdown.parse("plain words", implicitTitle: false).paragraphs[0].block == .body, "fragment keeps body")
check(NoteDocument(markdown: "").markdown == "", "empty note stays empty")

var table = NoteDocument(markdown: "# T\n| a | b |\n| --- | --- |\n| 1 | 2 |\nafter")
table.addRow(at: 2, below: true)
check(table.markdown == "# T\n| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |\nafter", "add row", table.markdown)
table.addColumn(at: 1, column: 0, after: true)
check(table.markdown == "# T\n| a |  | b |\n| --- | --- | --- |\n| 1 |  | 2 |\n|  |  |  |\nafter", "add column", table.markdown)
table.deleteColumn(at: 2, column: 2)
check(table.markdown == "# T\n| a |  |\n| --- | --- |\n| 1 |  |\n|  |  |\nafter", "delete column", table.markdown)
table.deleteRow(at: 1)
check(table.markdown == "# T\n| 1 |  |\n| --- | --- |\n|  |  |\nafter", "delete header row", table.markdown)
table.addRow(at: 1, below: false)
check(table.markdown == "# T\n|  |  |\n| --- | --- |\n| 1 |  |\n|  |  |\nafter", "add row above header", table.markdown)
var fresh = NoteDocument(markdown: "# T")
_ = fresh.insertTable(after: 0)
check(fresh.markdown == "# T\n|  |  |\n| --- | --- |\n|  |  |\n", "insert table", fresh.markdown)
check(NoteDocument(markdown: fresh.markdown) == fresh, "inserted table round trips")
check(NoteDocument(markdown: "[Groceries](puffer://note/abc)").paragraphs[0].inlines == [t("Groceries", link: "puffer://note/abc")], "note link")

let empties = NoteDocument(paragraphs: [NoteParagraph(block: .text(.title, quoted: false), inlines: [t("T")])] + [ListKind.bullet, .dash, .number, .checklist(checked: false), .checklist(checked: true)].map { NoteParagraph(block: .list($0, indent: 0, quoted: false), inlines: []) })
check(empties.markdown == "# T\n*\n-\n1.\n- [ ]\n- [x]", "empty items", empties.markdown)
check(NoteDocument(markdown: empties.markdown) == empties, "empty items round trip")

print(failures == 0 ? "ALL PASS" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
