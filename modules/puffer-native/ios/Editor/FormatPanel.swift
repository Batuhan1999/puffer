import UIKit

/// Apple Notes' Aa panel, shown in place of the keyboard.
final class FormatPanel: UIInputView {
  enum Command {
    case close
    case style(TextStyle)
    case mono
    case mark(InlineMarks)
    case highlight(Highlight?)
    case list(ListKind)
    case quote
    case indent(Int)
  }

  var onCommand: (Command) -> Void = { _ in }
  private var state = FormatState(block: .body, marks: [], highlight: nil)
  private var highlightColor = Highlight.purple
  private var styleButtons: [(UIButton, (NoteBlock) -> Bool)] = []
  private var markButtons: [(UIButton, InlineMarks)] = []
  private var listButtons: [(UIButton, ListKind)] = []
  private var quoteButton: UIButton?
  private var highlightButton: UIButton?

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 390, height: 262), inputViewStyle: .keyboard)
    allowsSelfSizing = true
    build()
  }

  required init?(coder: NSCoder) { fatalError("not coded") }

  override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: 262) }

  func update(_ state: FormatState) {
    self.state = state
    for (button, matches) in styleButtons { paint(button, on: matches(state.block)) }
    for (button, mark) in markButtons { paint(button, on: state.marks.contains(mark)) }
    for (button, kind) in listButtons {
      let on = switch (state.block.listKind, kind) {
      case let (current?, wanted): current == wanted
      default: false
      }
      paint(button, on: on)
    }
    if let quoteButton { paint(quoteButton, on: state.block.quoted) }
    if let highlightButton {
      paint(highlightButton, on: state.highlight != nil)
      highlightButton.configuration?.baseForegroundColor = NoteTheme.highlight(state.highlight ?? highlightColor)
    }
  }

  private func paint(_ button: UIButton, on: Bool) {
    button.configuration?.background.backgroundColor = on ? NoteTheme.tint.withAlphaComponent(0.28) : .clear
    button.isSelected = on
    button.accessibilityTraits = on ? [.button, .selected] : .button
  }

  private func build() {
    let title = UILabel()
    title.text = "Format"
    title.font = .systemFont(ofSize: 17, weight: .semibold)
    let close = UIButton(configuration: .plain(), primaryAction: UIAction { [weak self] _ in self?.onCommand(.close) })
    close.configuration?.image = UIImage(systemName: "xmark.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 24))
    close.configuration?.baseForegroundColor = .tertiaryLabel
    close.accessibilityLabel = "Close Format"
    let header = UIStackView(arrangedSubviews: [title, UIView(), close])
    header.alignment = .center

    let styles = UIStackView(arrangedSubviews: [
      styleChip("Title", .systemFont(ofSize: 20, weight: .bold)) { if case .text(.title, _) = $0 { true } else { false } } action: { .style(.title) },
      styleChip("Heading", .systemFont(ofSize: 17, weight: .bold)) { if case .text(.heading, _) = $0 { true } else { false } } action: { .style(.heading) },
      styleChip("Subheading", .systemFont(ofSize: 15, weight: .semibold)) { if case .text(.subheading, _) = $0 { true } else { false } } action: { .style(.subheading) },
      styleChip("Body", .systemFont(ofSize: 15)) { if case .text(.body, _) = $0 { true } else if case .list = $0 { true } else { false } } action: { .style(.body) },
      styleChip("Monostyled", .monospacedSystemFont(ofSize: 14, weight: .regular)) { $0 == .mono } action: { .mono },
    ])
    styles.spacing = 8
    let scroller = UIScrollView()
    scroller.showsHorizontalScrollIndicator = false
    scroller.addSubview(styles)
    styles.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      styles.leadingAnchor.constraint(equalTo: scroller.contentLayoutGuide.leadingAnchor),
      styles.trailingAnchor.constraint(equalTo: scroller.contentLayoutGuide.trailingAnchor),
      styles.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor),
      styles.bottomAnchor.constraint(equalTo: scroller.contentLayoutGuide.bottomAnchor),
      styles.heightAnchor.constraint(equalTo: scroller.frameLayoutGuide.heightAnchor),
      scroller.heightAnchor.constraint(equalToConstant: 44),
    ])

    let marks = group([
      markButton("bold", "Bold", .bold), markButton("italic", "Italic", .italic),
      markButton("underline", "Underline", .underline), markButton("strikethrough", "Strikethrough", .strike),
    ])
    let highlighter = iconButton("highlighter", "Highlight") { [weak self] in
      guard let self else { return .highlight(nil) }
      return .highlight(self.state.highlight == nil ? self.highlightColor : nil)
    }
    highlighter.menu = UIMenu(title: "Highlight", children: Highlight.allCases.map { color in
      UIAction(title: NoteTheme.highlightNames[color] ?? color.rawValue, image: UIImage(systemName: "circle.fill")?.withTintColor(NoteTheme.highlight(color), renderingMode: .alwaysOriginal)) { [weak self] _ in
        self?.highlightColor = color
        self?.onCommand(.highlight(color))
      }
    } + [UIAction(title: "Remove Highlight", image: UIImage(systemName: "xmark")) { [weak self] _ in self?.onCommand(.highlight(nil)) }])
    highlightButton = highlighter
    let highlightGroup = group([highlighter])
    let row2 = UIStackView(arrangedSubviews: [marks, highlightGroup])
    row2.spacing = 10
    marks.widthAnchor.constraint(equalTo: highlightGroup.widthAnchor, multiplier: 4).isActive = true

    let lists = group([
      listButton("list.bullet", "Bulleted List", .bullet), listButton("list.dash", "Dashed List", .dash),
      listButton("list.number", "Numbered List", .number),
    ])
    let quote = iconButton("text.quote", "Block Quote") { .quote }
    quoteButton = quote
    let indents = group([
      iconButton("decrease.indent", "Outdent") { .indent(-1) }, iconButton("increase.indent", "Indent") { .indent(1) },
    ])
    let quoteGroup = group([quote])
    let row3 = UIStackView(arrangedSubviews: [lists, quoteGroup, indents])
    row3.spacing = 10
    lists.widthAnchor.constraint(equalTo: quoteGroup.widthAnchor, multiplier: 3).isActive = true
    indents.widthAnchor.constraint(equalTo: quoteGroup.widthAnchor, multiplier: 2).isActive = true

    let column = UIStackView(arrangedSubviews: [header, scroller, row2, row3])
    column.axis = .vertical
    column.spacing = 12
    column.translatesAutoresizingMaskIntoConstraints = false
    addSubview(column)
    NSLayoutConstraint.activate([
      column.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      column.topAnchor.constraint(equalTo: topAnchor, constant: 12),
      row2.heightAnchor.constraint(equalToConstant: 46),
      row3.heightAnchor.constraint(equalToConstant: 46),
    ])
  }

  private func styleChip(_ label: String, _ font: UIFont, matches: @escaping (NoteBlock) -> Bool, action: @escaping () -> Command) -> UIButton {
    var configuration = UIButton.Configuration.plain()
    configuration.attributedTitle = AttributedString(label, attributes: AttributeContainer([.font: font]))
    configuration.baseForegroundColor = .label
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
    configuration.background.cornerRadius = 10
    let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.onCommand(action()) })
    button.configurationUpdateHandler = { button in
      button.configuration?.background.strokeColor = button.isSelected ? .clear : .separator
      button.configuration?.background.strokeWidth = 0.5
    }
    styleButtons.append((button, matches))
    return button
  }

  private func iconButton(_ symbol: String, _ label: String, _ command: @escaping () -> Command) -> UIButton {
    var configuration = UIButton.Configuration.plain()
    configuration.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .medium))
    configuration.baseForegroundColor = .label
    configuration.background.cornerRadius = 8
    let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.onCommand(command()) })
    button.accessibilityLabel = label
    return button
  }

  private func markButton(_ symbol: String, _ label: String, _ mark: InlineMarks) -> UIButton {
    let button = iconButton(symbol, label) { .mark(mark) }
    markButtons.append((button, mark))
    return button
  }

  private func listButton(_ symbol: String, _ label: String, _ kind: ListKind) -> UIButton {
    let button = iconButton(symbol, label) { .list(kind) }
    listButtons.append((button, kind))
    return button
  }

  private func group(_ buttons: [UIButton]) -> UIView {
    let stack = UIStackView(arrangedSubviews: buttons)
    stack.distribution = .fillEqually
    stack.spacing = 2
    stack.layoutMargins = UIEdgeInsets(top: 3, left: 3, bottom: 3, right: 3)
    stack.isLayoutMarginsRelativeArrangement = true
    stack.backgroundColor = .tertiarySystemFill
    stack.layer.cornerRadius = 12
    stack.layer.cornerCurve = .continuous
    return stack
  }
}
