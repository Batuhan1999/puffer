import UIKit

/// Apple Notes' Lines & Grids, chosen per note on this iPhone.
enum NotePaper: String, CaseIterable {
  case none, linesSmall, linesLarge, gridSmall, gridLarge

  private static func key(_ noteID: String) -> String { "puffer.note.paper." + noteID }

  static func of(_ noteID: String) -> NotePaper {
    UserDefaults.standard.string(forKey: key(noteID)).flatMap(NotePaper.init(rawValue:)) ?? .none
  }

  func save(for noteID: String) {
    if self == .none { UserDefaults.standard.removeObject(forKey: Self.key(noteID)) } else { UserDefaults.standard.set(rawValue, forKey: Self.key(noteID)) }
  }

  var spacing: CGFloat {
    switch self {
    case .none: 0
    case .linesSmall, .gridSmall: 24
    case .linesLarge, .gridLarge: 36
    }
  }

  var grid: Bool { self == .gridSmall || self == .gridLarge }

  /// One tile of the pattern, drawn for the current appearance.
  func tile(_ traits: UITraitCollection) -> UIImage? {
    guard self != .none else { return nil }
    let size = CGSize(width: grid ? spacing : 4, height: spacing)
    let line = UIColor.separator.resolvedColor(with: traits)
    return UIGraphicsImageRenderer(size: size).image { context in
      UIColor.systemBackground.resolvedColor(with: traits).setFill()
      context.fill(CGRect(origin: .zero, size: size))
      line.setFill()
      context.fill(CGRect(x: 0, y: size.height - 0.5, width: size.width, height: 0.5))
      if grid { context.fill(CGRect(x: size.width - 0.5, y: 0, width: 0.5, height: size.height)) }
    }
  }
}

/// Lies behind the text inside the text view, so it scrolls with it.
final class PaperView: UIView {
  var paper = NotePaper.none {
    didSet { redraw() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: PaperView, _: UITraitCollection) in view.redraw() }
  }

  required init?(coder: NSCoder) { fatalError("not coded") }

  private func redraw() {
    isHidden = paper == .none
    backgroundColor = paper.tile(traitCollection).map { UIColor(patternImage: $0) }
  }
}
