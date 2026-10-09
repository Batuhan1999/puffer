import ExpoModulesCore
import UIKit

/// The note editor React renders: a NoteTextView with Apple Notes' keyboard toolbar and Aa panel, the date above the
/// text, attachments, export, and a NoteSession that loads and saves the note.
final class NoteEditorView: ExpoView, NoteTextViewHost {
  let onEditingChange = EventDispatcher()
  let onOpenNote = EventDispatcher()

  var noteID: String? {
    didSet { if noteID != oldValue { open() } }
  }

  private let textView = NoteTextView()
  private let header = UILabel()
  private let paperView = PaperView()
  private let flows = AttachmentFlows()
  private lazy var accessory = makeAccessory()
  private lazy var formatPanel = makeFormatPanel()
  private var session: NoteSession?
  private var store: AttachmentStore?
  private var attachments: [String: NoteTextAttachment] = [:]
  private var attachmentWidth: CGFloat = 0
  private var saveTask: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .systemBackground
    textView.host = self
    textView.makeAttachment = { [weak self] ref in self?.attachment(ref) ?? NSTextAttachment() }
    textView.inputAccessoryView = accessory
    addSubview(textView)
    textView.insertSubview(paperView, at: 0)
    header.font = .preferredFont(forTextStyle: .footnote)
    header.adjustsFontForContentSizeCategory = true
    header.textColor = .secondaryLabel
    header.textAlignment = .center
    header.numberOfLines = 2
    textView.addSubview(header)
    flows.present = { [weak self] controller in self?.presentController(controller) }
    flows.insert = { [weak self] refs in self?.insertAttachments(refs) }
    flows.refresh = { [weak self] ref in
      self?.attachments[Self.key(ref)] = nil
      self?.textView.refreshAttachment(ref)
    }
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: NoteEditorView, _: UITraitCollection) in view.appearanceChanged() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    header.frame = CGRect(x: NoteTheme.margin, y: 8, width: bounds.width - 2 * NoteTheme.margin, height: header.numberOfLines == 2 && header.text?.contains("\n") == true ? 36 : 20)
    layoutPaper()
    let width = bounds.width - 2 * NoteTheme.margin
    if width > 0, abs(width - attachmentWidth) > 1, attachmentWidth > 0 {
      attachmentWidth = width
      reloadAttachments()
    }
  }

  private func layoutPaper() {
    let top = textView.textContainerInset.top - 6
    let height = max(textView.contentSize.height, textView.bounds.height) - top
    paperView.frame = CGRect(x: 0, y: top, width: textView.bounds.width, height: max(0, height + 400))
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      observers.forEach(NotificationCenter.default.removeObserver)
      observers = []
      saveTask?.cancel()
      session?.save()
      return
    }
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: Changes.notification, object: nil, queue: .main) { [weak self] note in
        guard note.userInfo?["topic"] as? String == Topic.notes.rawValue else { return }
        MainActor.assumeIsolated { self?.refresh() }
      },
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { _ = self?.session?.save() }
      },
      center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { [weak self] note in
        let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
        MainActor.assumeIsolated { self?.keyboardMoved(to: frame) }
      },
    ]
    refresh()
  }

  // MARK: session

  private func open() {
    session?.save()
    guard let noteID else { return }
    let store = AttachmentStore(noteID: noteID)
    self.store = store
    flows.store = store
    attachments = [:]
    attachmentWidth = (bounds.width > 0 ? bounds.width : UIScreen.main.bounds.width) - 2 * NoteTheme.margin
    paperView.paper = NotePaper.of(noteID)
    let session = NoteSession(
      id: NoteID(rawValue: noteID),
      read: { [textView] in textView.markdown },
      show: { [weak self] markdown, keepSelection in
        self?.textView.load(NoteDocument(markdown: markdown), keepSelection: keepSelection)
        self?.textView.undoManager?.removeAllActions()
      })
    session.onNote = { [weak self] note in self?.show(note) }
    self.session = session
    Task { @MainActor [weak self] in
      guard let note = await session.load(), let self else { return }
      if note.deletedAt == nil, note.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        self.textView.becomeFirstResponder()
      }
    }
  }

  private func refresh() {
    guard let session else { return }
    Task { @MainActor in await session.refresh() }
  }

  private static let dateFormat: DateFormatter = {
    let format = DateFormatter()
    format.dateStyle = .long
    format.timeStyle = .short
    return format
  }()

  private func show(_ note: Note) {
    textView.isEditable = note.deletedAt == nil
    let date = Self.dateFormat.string(from: note.modifiedAt)
    if case let .agent(_, name) = note.lastEditor {
      header.text = "\(date)\nEdited by \(name)"
      textView.textContainerInset.top = 66
    } else {
      header.text = date
      textView.textContainerInset.top = 48
    }
    setNeedsLayout()
  }

  private func scheduleSave() {
    saveTask?.cancel()
    saveTask = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(600))
      guard !Task.isCancelled else { return }
      self?.session?.save()
    }
  }

  // MARK: attachments

  private static func key(_ ref: AttachmentRef) -> String { ref.file + "|" + ref.name }

  private func attachment(_ ref: AttachmentRef) -> NSTextAttachment {
    if let cached = attachments[Self.key(ref)] { return cached }
    let width = max(120, attachmentWidth)
    let image = store.map { AttachmentImages.image(ref, store: $0, width: width) } ?? UIImage()
    let attachment = NoteTextAttachment(ref: ref, image: image, width: width)
    attachments[Self.key(ref)] = attachment
    return attachment
  }

  private func reloadAttachments() {
    let refs = Set(attachments.values.map(\.ref))
    attachments = [:]
    refs.forEach(textView.refreshAttachment)
  }

  private func insertAttachments(_ refs: [AttachmentRef]) {
    guard !refs.isEmpty else { return }
    if !textView.isFirstResponder {
      textView.selectedRange = NSRange(location: max(0, textView.textStorage.length - 1), length: 0)
    }
    textView.insertAttachments(refs)
  }

  private func appearanceChanged() {
    reloadAttachments()
    if let manager = textView.textLayoutManager { manager.invalidateLayout(for: manager.documentRange) }
    textView.setNeedsDisplay()
  }

  // MARK: keyboard and panels

  private func keyboardMoved(to frame: CGRect?) {
    guard let frame, let window else { return }
    let mine = convert(bounds, to: window)
    let overlap = max(0, mine.maxY - frame.minY)
    let inset = max(0, overlap - safeAreaInsets.bottom)
    textView.contentInset.bottom = inset
    textView.verticalScrollIndicatorInsets.bottom = inset
    if textView.isFirstResponder, overlap > 0 { textView.scrollRangeToVisible(textView.selectedRange) }
  }

  private func makeAccessory() -> UIToolbar {
    let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 390, height: 44))
    bar.tintColor = .label
    let format = UIBarButtonItem(image: UIImage(systemName: "textformat"), primaryAction: UIAction { [weak self] _ in self?.showFormat() })
    format.accessibilityLabel = "Format"
    let checklist = UIBarButtonItem(image: UIImage(systemName: "checklist"), primaryAction: UIAction { [weak self] _ in self?.textView.toggleList(.checklist(checked: false)) })
    checklist.accessibilityLabel = "Checklist"
    let table = UIBarButtonItem(image: UIImage(systemName: "tablecells"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
      guard let self else { return done([]) }
      done(self.textView.inTable ? self.textView.tableMenu.children : [UIAction(title: "Insert Table", image: UIImage(systemName: "tablecells.badge.ellipsis")) { [weak self] _ in self?.textView.table(.insert) }])
    }]))
    table.accessibilityLabel = "Table"
    let attach = UIBarButtonItem(image: UIImage(systemName: "paperclip"), menu: AttachmentFlows.menu { [weak self] kind in self?.flows.start(kind) })
    attach.accessibilityLabel = "Attach"
    let hide = UIBarButtonItem(image: UIImage(systemName: "keyboard.chevron.compact.down"), primaryAction: UIAction { [weak self] _ in self?.textView.resignFirstResponder() })
    hide.accessibilityLabel = "Hide Keyboard"
    bar.items = [format, .flexibleSpace(), checklist, .flexibleSpace(), table, .flexibleSpace(), attach, .flexibleSpace(), hide]
    bar.sizeToFit()
    return bar
  }

  private func makeFormatPanel() -> FormatPanel {
    let panel = FormatPanel()
    panel.onCommand = { [weak self] command in
      guard let self else { return }
      switch command {
      case .close: self.hideFormat()
      case let .style(style): self.textView.applyStyle(style)
      case .mono: self.textView.applyMono()
      case let .mark(mark): self.textView.toggleMark(mark)
      case let .highlight(color): self.textView.setHighlight(color)
      case let .list(kind): self.textView.toggleList(kind)
      case .quote: self.textView.toggleQuote()
      case let .indent(delta): self.textView.indent(delta)
      }
      self.formatPanel.update(self.textView.formatState)
    }
    return panel
  }

  private func showFormat() {
    if !textView.isFirstResponder { textView.becomeFirstResponder() }
    formatPanel.update(textView.formatState)
    textView.inputView = formatPanel
    textView.inputAccessoryView = nil
    textView.reloadInputViews()
  }

  private func hideFormat() {
    guard textView.inputView != nil else { return }
    textView.inputView = nil
    textView.inputAccessoryView = accessory
    textView.reloadInputViews()
  }

  private func presentController(_ controller: UIViewController) {
    guard var top = appContext?.utilities?.currentViewController() ?? window?.rootViewController else { return }
    while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
    top.present(controller, animated: true)
  }

  // MARK: NoteTextViewHost

  func noteTextViewDidChange(_ view: NoteTextView) {
    scheduleSave()
    layoutPaper()
  }

  func noteTextViewDidChangeSelection(_ view: NoteTextView) {
    if textView.inputView === formatPanel { formatPanel.update(view.formatState) }
  }

  func noteTextView(_ view: NoteTextView, didChangeEditing editing: Bool) {
    onEditingChange(["editing": editing])
    if !editing {
      hideFormat()
      saveTask?.cancel()
      session?.save()
    }
  }

  func noteTextView(_ view: NoteTextView, open ref: AttachmentRef) {
    session?.save()
    flows.open(ref)
  }

  func noteTextView(_ view: NoteTextView, paste images: [UIImage]) {
    flows.saveImages(images, name: "Image")
  }

  func noteTextView(_ view: NoteTextView, present controller: UIViewController) {
    presentController(controller)
  }

  func noteTextView(_ view: NoteTextView, openNote id: String) {
    session?.save()
    onOpenNote(["noteId": id])
  }

  func noteTextView(_ view: NoteTextView, wantsNoteLinkReplacing range: NSRange) {
    let current = noteID
    Task { @MainActor [weak self] in
      let notes = ((try? await NoteBook.shared.live()) ?? []).filter { $0.id.rawValue != current && !$0.title.isEmpty }.sorted { $0.modifiedAt > $1.modifiedAt }
      guard let self, !notes.isEmpty else { return }
      let picker = NoteLinkPicker(notes: notes.map { ($0.id.rawValue, $0.title) }) { [weak self] picked in
        guard let self, let picked else { return }
        self.textView.insertNoteLink(title: picked.title, id: picked.id, replacing: range)
        self.textView.becomeFirstResponder()
      }
      let navigation = UINavigationController(rootViewController: picker)
      navigation.sheetPresentationController?.detents = [.medium(), .large()]
      self.presentController(navigation)
    }
  }

  // MARK: JS commands

  func finishEditing() {
    textView.resignFirstResponder()
  }

  func find() {
    textView.findInteraction?.presentFindNavigator(showingReplace: false)
  }

  func copyNote() {
    NoteExport.copy(textView.document)
  }

  func moveCheckedToBottom() {
    textView.transform("Move Checked Items") { $0.moveCheckedToBottom() }
  }

  func uncheckAll() {
    textView.transform("Uncheck All") { $0.uncheckAll() }
  }

  /// From the bottom toolbar: a new checklist line at the end of the note, ready to type.
  func toggleChecklist() {
    if !textView.isFirstResponder {
      let length = textView.textStorage.length
      textView.selectedRange = NSRange(location: max(0, length - 1), length: 0)
      textView.becomeFirstResponder()
      let last = textView.paragraph(at: max(0, length - 1))
      if last.length > 1 { textView.insertText("\n") }
    }
    textView.toggleList(.checklist(checked: false))
  }

  func attach(_ kind: String) {
    guard let kind = AttachmentFlows.Kind(rawValue: kind) else { return }
    flows.start(kind)
  }

  func setPaper(_ name: String) {
    guard let paper = NotePaper(rawValue: name), let noteID else { return }
    paper.save(for: noteID)
    paperView.paper = paper
  }

  func insertTable() {
    if !textView.isFirstResponder {
      textView.selectedRange = NSRange(location: max(0, textView.textStorage.length - 1), length: 0)
      textView.becomeFirstResponder()
    }
    textView.table(.insert)
  }

  /// `text`, `markdown`, `pdf` or `print`.
  func share(_ kind: String) {
    session?.save()
    NoteExport.share(textView.document, kind: kind, attachment: { [weak self] ref in self?.attachment(ref) ?? NSTextAttachment() }, sourceView: self) { [weak self] in self?.presentController($0) }
  }
}

/// The `>>` sheet: pick a note to link, newest first, with search.
final class NoteLinkPicker: UITableViewController, UISearchResultsUpdating {
  private let notes: [(id: String, title: String)]
  private var shown: [(id: String, title: String)]
  private let done: ((id: String, title: String)?) -> Void
  private var finished = false

  init(notes: [(id: String, title: String)], done: @escaping ((id: String, title: String)?) -> Void) {
    self.notes = notes
    shown = notes
    self.done = done
    super.init(style: .insetGrouped)
  }

  required init?(coder: NSCoder) { fatalError("not coded") }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Link to Note"
    let search = UISearchController(searchResultsController: nil)
    search.searchResultsUpdater = self
    search.obscuresBackgroundDuringPresentation = false
    navigationItem.searchController = search
    navigationItem.hidesSearchBarWhenScrolling = false
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    tableView.register(UITableViewCell.self, forCellReuseIdentifier: "note")
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if !finished { done(nil) }
  }

  func updateSearchResults(for searchController: UISearchController) {
    let query = searchController.searchBar.text?.trimmingCharacters(in: .whitespaces) ?? ""
    shown = query.isEmpty ? notes : notes.filter { $0.title.localizedCaseInsensitiveContains(query) }
    tableView.reloadData()
  }

  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { shown.count }

  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "note", for: indexPath)
    var content = cell.defaultContentConfiguration()
    content.text = shown[indexPath.row].title
    content.image = UIImage(systemName: "note.text")
    content.imageProperties.tintColor = NoteTheme.tint
    cell.contentConfiguration = content
    return cell
  }

  override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    finished = true
    let picked = shown[indexPath.row]
    dismiss(animated: true) { [done] in done(picked) }
  }
}
