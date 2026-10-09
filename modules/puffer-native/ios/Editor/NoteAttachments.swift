import ImageIO
import PDFKit
import PencilKit
import PhotosUI
import QuickLook
import UIKit
import UniformTypeIdentifiers
import VisionKit

/// A note's files: Documents/NoteAttachments/<note id>/<file>. Agents see only the `attachment:<file>` references.
struct AttachmentStore {
  static let root = PufferEngine.documents.appendingPathComponent("NoteAttachments", isDirectory: true)
  let noteID: String

  var folder: URL { Self.root.appendingPathComponent(noteID, isDirectory: true) }

  /// nil for a reference that tries to leave the note's folder; references come from Markdown agents may write.
  func url(_ ref: AttachmentRef) -> URL? {
    let name = (ref.file as NSString).lastPathComponent
    guard !name.isEmpty, !name.hasPrefix("."), name == ref.file else { return nil }
    return folder.appendingPathComponent(name)
  }

  /// PencilKit's own data next to a drawing's PNG, so the drawing stays editable.
  func drawingURL(_ ref: AttachmentRef) -> URL? {
    url(ref)?.deletingPathExtension().appendingPathExtension("drawing")
  }

  func save(_ data: Data, ext: String, name: String) throws -> AttachmentRef {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = UUID().uuidString.prefix(8).lowercased() + "." + ext.lowercased()
    try data.write(to: folder.appendingPathComponent(file), options: .atomic)
    return AttachmentRef(name: name, file: file)
  }

  func copy(_ source: URL) throws -> AttachmentRef {
    let scoped = source.startAccessingSecurityScopedResource()
    defer { if scoped { source.stopAccessingSecurityScopedResource() } }
    let ext = source.pathExtension.isEmpty ? "bin" : source.pathExtension
    return try save(try Data(contentsOf: source), ext: ext, name: source.deletingPathExtension().lastPathComponent)
  }
}

enum AttachmentImages {
  /// What the editor shows for an attachment: the picture itself, or a card with the file's first page and name.
  static func image(_ ref: AttachmentRef, store: AttachmentStore, width: CGFloat) -> UIImage {
    guard let url = store.url(ref), FileManager.default.fileExists(atPath: url.path) else {
      return card(title: ref.name, subtitle: "Attachment missing", thumbnail: nil, symbol: "exclamationmark.triangle", width: width)
    }
    let type = UTType(filenameExtension: url.pathExtension)
    if type?.conforms(to: .image) == true, let image = downsampled(url, maxPoints: width) {
      return rounded(image)
    }
    if type?.conforms(to: .pdf) == true, let pdf = PDFDocument(url: url) {
      let thumbnail = pdf.page(at: 0)?.thumbnail(of: CGSize(width: 120, height: 160), for: .mediaBox)
      let pages = pdf.pageCount == 1 ? "1 page" : "\(pdf.pageCount) pages"
      return card(title: ref.name, subtitle: "PDF Document · \(pages)", thumbnail: thumbnail, symbol: "doc.richtext", width: width)
    }
    return card(title: ref.name, subtitle: url.pathExtension.uppercased(), thumbnail: nil, symbol: "doc", width: width)
  }

  private static func downsampled(_ url: URL, maxPoints: CGFloat) -> UIImage? {
    let scale = UITraitCollection.current.displayScale > 0 ? UITraitCollection.current.displayScale : 3
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: maxPoints * scale,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: image, scale: scale, orientation: .up)
  }

  private static func rounded(_ image: UIImage) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      UIBezierPath(roundedRect: CGRect(origin: .zero, size: image.size), cornerRadius: 10).addClip()
      image.draw(at: .zero)
    }
  }

  private static func fit(_ size: CGSize, in rect: CGRect) -> CGRect {
    let scale = min(rect.width / max(1, size.width), rect.height / max(1, size.height))
    let fitted = CGSize(width: size.width * scale, height: size.height * scale)
    return CGRect(x: rect.midX - fitted.width / 2, y: rect.midY - fitted.height / 2, width: fitted.width, height: fitted.height)
  }

  private static func card(title: String, subtitle: String, thumbnail: UIImage?, symbol: String, width: CGFloat) -> UIImage {
    let size = CGSize(width: width, height: 76)
    return UIGraphicsImageRenderer(size: size).image { _ in
      let box = UIBezierPath(roundedRect: CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5), cornerRadius: 12)
      UIColor.secondarySystemBackground.setFill()
      box.fill()
      UIColor.separator.setStroke()
      box.stroke()
      let icon = CGRect(x: 12, y: 10, width: 42, height: 56)
      if let thumbnail {
        let fit = fit(thumbnail.size, in: icon)
        thumbnail.draw(in: fit)
        UIColor.separator.setStroke()
        UIBezierPath(rect: fit).stroke()
      } else if let glyph = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 28))?.withTintColor(.secondaryLabel, renderingMode: .alwaysOriginal) {
        glyph.draw(in: fit(glyph.size, in: icon.insetBy(dx: 4, dy: 10)))
      }
      let titleStyle = NSMutableParagraphStyle()
      titleStyle.lineBreakMode = .byTruncatingMiddle
      (title as NSString).draw(in: CGRect(x: 66, y: 18, width: width - 80, height: 22), withAttributes: [.font: UIFont.systemFont(ofSize: 16, weight: .semibold), .foregroundColor: UIColor.label, .paragraphStyle: titleStyle])
      (subtitle as NSString).draw(in: CGRect(x: 66, y: 41, width: width - 80, height: 20), withAttributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: UIColor.secondaryLabel])
    }
  }
}

extension AttachmentImages {
  /// What the Tiptap editor shows for an attachment, as data URLs a WebView can load (it cannot read the app's files).
  static func preview(_ ref: AttachmentRef, store: AttachmentStore, width: CGFloat) -> [String: Any] {
    guard let url = store.url(ref), FileManager.default.fileExists(atPath: url.path) else {
      return ["kind": "card", "title": ref.name, "subtitle": "Attachment missing", "thumbnail": NSNull(), "symbol": "missing"]
    }
    let type = UTType(filenameExtension: url.pathExtension)
    if type?.conforms(to: .image) == true, let image = downsampled(url, maxPoints: width) {
      let png = type?.conforms(to: .png) == true
      if let data = png ? image.pngData() : image.jpegData(compressionQuality: 0.82) {
        return ["kind": "image", "src": "data:image/\(png ? "png" : "jpeg");base64," + data.base64EncodedString()]
      }
    }
    if type?.conforms(to: .pdf) == true, let pdf = PDFDocument(url: url) {
      let thumbnail = pdf.page(at: 0)?.thumbnail(of: CGSize(width: 120, height: 160), for: .mediaBox).pngData()
      let pages = pdf.pageCount == 1 ? "1 page" : "\(pdf.pageCount) pages"
      return [
        "kind": "card", "title": ref.name, "subtitle": "PDF Document · \(pages)", "symbol": "pdf",
        "thumbnail": thumbnail.map { "data:image/png;base64," + $0.base64EncodedString() } ?? NSNull(),
      ]
    }
    return ["kind": "card", "title": ref.name, "subtitle": url.pathExtension.uppercased(), "thumbnail": NSNull(), "symbol": "file"]
  }
}

/// The attachment menu's sources and the viewer. Each flow ends by handing the editor the references it saved.
final class AttachmentFlows: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate,
  VNDocumentCameraViewControllerDelegate, UIDocumentPickerDelegate, QLPreviewControllerDataSource {
  enum Kind: String, CaseIterable {
    case photos, camera, scan, files, drawing

    var title: String {
      switch self {
      case .photos: "Choose Photo"
      case .camera: "Take Photo"
      case .scan: "Scan Documents"
      case .files: "Attach File"
      case .drawing: "Drawing"
      }
    }

    var symbol: String {
      switch self {
      case .photos: "photo.on.rectangle"
      case .camera: "camera"
      case .scan: "doc.viewfinder"
      case .files: "doc"
      case .drawing: "pencil.tip.crop.circle"
      }
    }

    var available: Bool {
      switch self {
      case .camera: UIImagePickerController.isSourceTypeAvailable(.camera)
      case .scan: VNDocumentCameraViewController.isSupported
      case .photos, .files, .drawing: true
      }
    }
  }

  var store: AttachmentStore?
  var present: (UIViewController) -> Void = { _ in }
  var insert: ([AttachmentRef]) -> Void = { _ in }
  var refresh: (AttachmentRef) -> Void = { _ in }
  private var previewURL: URL?

  static func menu(_ handler: @escaping (Kind) -> Void) -> UIMenu {
    UIMenu(children: Kind.allCases.filter(\.available).map { kind in
      UIAction(title: kind.title, image: UIImage(systemName: kind.symbol)) { _ in handler(kind) }
    })
  }

  func start(_ kind: Kind) {
    guard kind.available else { return }
    switch kind {
    case .photos:
      var configuration = PHPickerConfiguration()
      configuration.filter = .images
      configuration.selectionLimit = 0
      let picker = PHPickerViewController(configuration: configuration)
      picker.delegate = self
      present(picker)
    case .camera:
      let picker = UIImagePickerController()
      picker.sourceType = .camera
      picker.delegate = self
      present(picker)
    case .scan:
      let scanner = VNDocumentCameraViewController()
      scanner.delegate = self
      present(scanner)
    case .files:
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.pdf, .image], asCopy: true)
      picker.allowsMultipleSelection = true
      picker.delegate = self
      present(picker)
    case .drawing:
      openDrawing(nil)
    }
  }

  func open(_ ref: AttachmentRef) {
    guard let store, let url = store.url(ref) else { return }
    if let drawing = store.drawingURL(ref), FileManager.default.fileExists(atPath: drawing.path) {
      openDrawing(ref)
      return
    }
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    previewURL = url
    let preview = QLPreviewController()
    preview.dataSource = self
    present(preview)
  }

  func saveImages(_ images: [UIImage], name: String) {
    guard let store else { return }
    let refs = images.compactMap { image in image.jpegData(compressionQuality: 0.85).flatMap { try? store.save($0, ext: "jpg", name: name) } }
    insert(refs)
  }

  // MARK: photos

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard !results.isEmpty else { return }
    var images = [UIImage?](repeating: nil, count: results.count)
    let group = DispatchGroup()
    for (index, result) in results.enumerated() where result.itemProvider.canLoadObject(ofClass: UIImage.self) {
      group.enter()
      result.itemProvider.loadObject(ofClass: UIImage.self) { object, _ in
        DispatchQueue.main.async {
          images[index] = object as? UIImage
          group.leave()
        }
      }
    }
    group.notify(queue: .main) { [weak self] in self?.saveImages(images.compactMap { $0 }, name: "Photo") }
  }

  func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
    picker.dismiss(animated: true)
    if let image = info[.originalImage] as? UIImage { saveImages([image], name: "Photo") }
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { picker.dismiss(animated: true) }

  // MARK: scan

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
    controller.dismiss(animated: true)
    let pdf = PDFDocument()
    for index in 0..<scan.pageCount {
      if let page = PDFPage(image: scan.imageOfPage(at: index)) { pdf.insert(page, at: pdf.pageCount) }
    }
    guard pdf.pageCount > 0, let data = pdf.dataRepresentation(), let store, let ref = try? store.save(data, ext: "pdf", name: scan.title.isEmpty ? "Scanned Document" : scan.title) else { return }
    insert([ref])
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { controller.dismiss(animated: true) }

  func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { controller.dismiss(animated: true) }

  // MARK: files

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let store else { return }
    insert(urls.compactMap { try? store.copy($0) })
  }

  // MARK: drawing

  private func openDrawing(_ ref: AttachmentRef?) {
    let existing = ref.flatMap { store?.drawingURL($0) }.flatMap { try? Data(contentsOf: $0) }.flatMap { try? PKDrawing(data: $0) }
    let controller = DrawingController(drawing: existing ?? PKDrawing())
    controller.onDone = { [weak self] drawing in
      guard let self, let store = self.store, !drawing.strokes.isEmpty else { return }
      let image = DrawingController.render(drawing)
      guard let png = image.pngData() else { return }
      if let ref, let url = store.url(ref), let sidecar = store.drawingURL(ref) {
        try? png.write(to: url, options: .atomic)
        try? drawing.dataRepresentation().write(to: sidecar, options: .atomic)
        self.refresh(ref)
      } else if let saved = try? store.save(png, ext: "png", name: "Drawing"), let sidecar = store.drawingURL(saved) {
        try? drawing.dataRepresentation().write(to: sidecar, options: .atomic)
        self.insert([saved])
      }
    }
    let navigation = UINavigationController(rootViewController: controller)
    navigation.modalPresentationStyle = .fullScreen
    present(navigation)
  }

  // MARK: Quick Look

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
  }
}

/// A full-screen PencilKit canvas; finger drawing is on, as in Apple Notes.
final class DrawingController: UIViewController, PKCanvasViewDelegate {
  var onDone: (PKDrawing) -> Void = { _ in }
  private let canvas = PKCanvasView()
  private let toolPicker = PKToolPicker()

  init(drawing: PKDrawing) {
    super.init(nibName: nil, bundle: nil)
    canvas.drawing = drawing
  }

  required init?(coder: NSCoder) { fatalError("not coded") }

  /// Ink on white, rendered in light mode so it reads the same wherever the PNG goes.
  static func render(_ drawing: PKDrawing) -> UIImage {
    let bounds = drawing.bounds.insetBy(dx: -24, dy: -24)
    var image = UIImage()
    UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
      let ink = drawing.image(from: bounds, scale: 2)
      image = UIGraphicsImageRenderer(size: bounds.size).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: bounds.size))
        ink.draw(at: .zero)
      }
    }
    return image
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    overrideUserInterfaceStyle = .light
    navigationController?.navigationBar.tintColor = NoteTheme.tint
    view.backgroundColor = .white
    canvas.backgroundColor = .white
    canvas.drawingPolicy = .anyInput
    canvas.alwaysBounceVertical = true
    canvas.frame = view.bounds
    canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(canvas)
    navigationItem.title = "Drawing"
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      let drawing = self.canvas.drawing
      self.dismiss(animated: true) { self.onDone(drawing) }
    })
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    toolPicker.setVisible(true, forFirstResponder: canvas)
    toolPicker.addObserver(canvas)
    canvas.becomeFirstResponder()
  }
}
