import UIKit

/// Draws what a paragraph shows besides its text: list marks, checkboxes, the quote bar, the monostyled background and
/// table rules. None of it is in the text, so the cursor never lands on a mark.
final class NoteLayoutFragment: NSTextLayoutFragment {
  private var block: NoteBlock {
    guard let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return .body }
    return paragraph.attributedString.block(at: 0)
  }

  private var ordinal: Int? {
    guard let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return nil }
    return paragraph.attributedString.attribute(.noteOrdinal, at: 0, effectiveRange: nil) as? Int
  }

  private func flag(_ key: NSAttributedString.Key) -> Bool {
    guard let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return false }
    let text = paragraph.attributedString
    return text.attribute(key, at: text.length - 1, effectiveRange: nil) != nil
  }

  private var tabStops: [CGFloat] {
    guard let paragraph = textElement as? NSTextParagraph, paragraph.attributedString.length > 0 else { return [] }
    let style = paragraph.attributedString.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
    return style?.tabStops.map(\.location) ?? []
  }

  /// TextKit places a fragment at its paragraph's indent, so marks are positioned from the container's left edge.
  override var renderingSurfaceBounds: CGRect {
    let frame = layoutFragmentFrame
    let left = -frame.minX - NoteTheme.margin
    let right = max(frame.width, (textLayoutManager?.textContainer?.size.width ?? frame.maxX) - frame.minX)
    return super.renderingSurfaceBounds.union(CGRect(x: left, y: 0, width: right - left, height: frame.height))
  }

  override func draw(at point: CGPoint, in context: CGContext) {
    let block = block
    let frame = layoutFragmentFrame
    let zero = point.x - frame.minX
    let width = textLayoutManager?.textContainer?.size.width ?? frame.maxX
    UIGraphicsPushContext(context)
    defer { UIGraphicsPopContext() }
    switch block {
    case .mono:
      UIColor.secondarySystemFill.setFill()
      UIRectFill(CGRect(x: zero, y: point.y, width: width, height: frame.height))
    case let .tableRow(header):
      // The last tab stop is the table's right edge; the others start columns, with 10 points before the text.
      let edges = [0] + tabStops.map { $0 - 10 }
      let tableWidth = min(width, edges.last ?? width)
      if header {
        UIColor.tertiarySystemFill.setFill()
        UIRectFill(CGRect(x: zero, y: point.y, width: tableWidth, height: frame.height))
      }
      UIColor.separator.setFill()
      UIRectFill(CGRect(x: zero, y: point.y + frame.height - 0.5, width: tableWidth, height: 0.5))
      if header { UIRectFill(CGRect(x: zero, y: point.y, width: tableWidth, height: 0.5)) }
      for edge in edges {
        UIRectFill(CGRect(x: zero + min(max(0, edge), tableWidth - 0.5), y: point.y, width: 0.5, height: frame.height))
      }
    default:
      break
    }
    if block.quoted {
      UIColor.tertiaryLabel.setFill()
      UIBezierPath(roundedRect: CGRect(x: zero + 2, y: point.y + 2, width: 3, height: frame.height - 4), cornerRadius: 1.5).fill()
    }
    super.draw(at: point, in: context)
    if block.headingLevel != nil, let line = textLineFragments.first {
      let collapsed = flag(.noteCollapsed)
      if collapsed || flag(.noteActive) {
        let configuration = UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        let chevron = UIImage(systemName: collapsed ? "chevron.right" : "chevron.down", withConfiguration: configuration)?
          .withTintColor(collapsed ? NoteTheme.tint : .tertiaryLabel, renderingMode: .alwaysOriginal)
        if let chevron {
          let mid = point.y + line.typographicBounds.midY
          chevron.draw(at: CGPoint(x: zero - NoteTheme.margin + (NoteTheme.margin - chevron.size.width) / 2 - 2, y: mid - chevron.size.height / 2))
        }
      }
    }
    guard case let .list(kind, _, _) = block, let line = textLineFragments.first else { return }
    let lead = NoteTheme.leading(block)
    let bounds = line.typographicBounds
    let baseline = point.y + bounds.minY + line.glyphOrigin.y
    let font = NoteTheme.font(block)
    switch kind {
    case let .checklist(checked):
      let size = font.pointSize * 1.3
      let rect = CGRect(x: zero + lead - NoteTheme.checkboxWidth + 2, y: point.y + bounds.midY - size / 2, width: size, height: size)
      let configuration = UIImage.SymbolConfiguration(pointSize: size * 0.85, weight: .regular)
      let image: UIImage? = checked
        ? UIImage(systemName: "checkmark.circle.fill", withConfiguration: configuration.applying(UIImage.SymbolConfiguration(paletteColors: [.white, NoteTheme.tint])))
        : UIImage(systemName: "circle", withConfiguration: configuration)?.withTintColor(.tertiaryLabel, renderingMode: .alwaysOriginal)
      image?.draw(in: rect)
    default:
      let mark: String
      switch kind {
      case .bullet: mark = "•"
      case .dash: mark = "–"
      default: mark = "\(ordinal ?? 1)."
      }
      let attributes: [NSAttributedString.Key: Any] = [.font: kind == .number ? UIFont.monospacedDigitSystemFont(ofSize: font.pointSize, weight: .regular) : font, .foregroundColor: kind == .number ? UIColor.secondaryLabel : UIColor.label]
      let text = NSAttributedString(string: mark, attributes: attributes)
      let size = text.size()
      text.draw(at: CGPoint(x: zero + lead - 6 - size.width, y: baseline - font.ascender))
    }
  }
}
