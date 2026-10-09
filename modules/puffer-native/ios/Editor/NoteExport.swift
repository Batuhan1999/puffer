import UIKit
import UniformTypeIdentifiers

/// Send a Copy, Markdown and PDF export, Print and Copy, for both editors.
@MainActor
enum NoteExport {
  /// `text`, `markdown`, `pdf` or `print`.
  static func share(_ document: NoteDocument, kind: String, attachment: (AttachmentRef) -> NSTextAttachment, sourceView: UIView?, present: (UIViewController) -> Void) {
    let title = NoteText.title(document.markdown)
    let name = String((title.isEmpty ? "Note" : title).map { "/:\\?%*|\"<>".contains($0) ? "-" : $0 }.prefix(80))
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Export", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var items: [Any] = [document.plainText]
    switch kind {
    case "markdown":
      let url = folder.appendingPathComponent(name + ".md")
      guard (try? document.markdown.write(to: url, atomically: true, encoding: .utf8)) != nil else { return }
      items = [url]
    case "pdf":
      let url = folder.appendingPathComponent(name + ".pdf")
      guard (try? pdf(NoteRendering.printable(document, attachment: attachment)).write(to: url, options: .atomic)) != nil else { return }
      items = [url]
    case "print":
      let printer = UIPrintInteractionController.shared
      let info = UIPrintInfo.printInfo()
      info.jobName = name
      info.outputType = .general
      printer.printInfo = info
      printer.printFormatter = UISimpleTextPrintFormatter(attributedText: NoteRendering.printable(document, attachment: attachment))
      printer.present(animated: true)
      return
    default:
      break
    }
    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    controller.popoverPresentationController?.sourceView = sourceView
    present(controller)
  }

  /// Plain text for apps that take text, Markdown for Puffer and editors that read it.
  static func copy(_ document: NoteDocument) {
    UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: document.plainText, NoteTextView.markdownType: document.markdown]])
  }

  private static func pdf(_ text: NSAttributedString) -> Data {
    let renderer = UIPrintPageRenderer()
    renderer.addPrintFormatter(UISimpleTextPrintFormatter(attributedText: text), startingAtPageAt: 0)
    let paper = CGRect(x: 0, y: 0, width: 612, height: 792)
    renderer.setValue(paper, forKey: "paperRect")
    renderer.setValue(paper.insetBy(dx: 54, dy: 54), forKey: "printableRect")
    let data = NSMutableData()
    UIGraphicsBeginPDFContextToData(data, paper, nil)
    renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
    for page in 0..<renderer.numberOfPages {
      UIGraphicsBeginPDFPage()
      renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
    }
    UIGraphicsEndPDFContext()
    return data as Data
  }
}
