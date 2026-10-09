// Reads a JSON array of specs on stdin and writes each as a text PDF (with document attributes) or a PNG.
import AppKit
import CoreText

struct Spec: Decodable {
  let out: String
  let kind: String
  let body: String
  let title: String?
  let author: String?
  let subject: String?
  let keywords: String?
  let width: Double?
  let height: Double?
  let background: [Double]?
  let scale: Double?
}

func attributed(_ body: String, scale: CGFloat) -> NSAttributedString {
  let out = NSMutableAttributedString()
  for raw in body.split(separator: "\n", omittingEmptySubsequences: false) {
    var line = String(raw)
    var font = NSFont.systemFont(ofSize: 11 * scale)
    if line.hasPrefix("# ") {
      line.removeFirst(2)
      font = .boldSystemFont(ofSize: 18 * scale)
    } else if line.hasPrefix("## ") {
      line.removeFirst(3)
      font = .boldSystemFont(ofSize: 13 * scale)
    }
    out.append(NSAttributedString(string: line + "\n", attributes: [.font: font]))
  }
  return out
}

func writePDF(_ spec: Spec) {
  var box = CGRect(x: 0, y: 0, width: 595, height: 842)
  let info: [CFString: Any] = [
    kCGPDFContextTitle: spec.title ?? "",
    kCGPDFContextAuthor: spec.author ?? "",
    kCGPDFContextSubject: spec.subject ?? "",
    kCGPDFContextKeywords: spec.keywords ?? "",
    kCGPDFContextCreator: spec.author ?? "",
  ]
  guard let ctx = CGContext(URL(fileURLWithPath: spec.out) as CFURL, mediaBox: &box, info as CFDictionary) else {
    fatalError("cannot open \(spec.out)")
  }
  let text = attributed(spec.body, scale: 1)
  let setter = CTFramesetterCreateWithAttributedString(text)
  let path = CGPath(rect: box.insetBy(dx: 56, dy: 56), transform: nil)
  var start = 0
  while start < text.length {
    ctx.beginPDFPage(nil)
    let frame = CTFramesetterCreateFrame(setter, CFRange(location: start, length: 0), path, nil)
    CTFrameDraw(frame, ctx)
    ctx.endPDFPage()
    let shown = CTFrameGetVisibleStringRange(frame).length
    if shown == 0 { break }
    start += shown
  }
  ctx.closePDF()
}

func writePNG(_ spec: Spec) {
  let w = Int(spec.width ?? 1170), h = Int(spec.height ?? 2532)
  let ctx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let bg = spec.background ?? [1, 1, 1]
  ctx.setFillColor(CGColor(srgbRed: bg[0], green: bg[1], blue: bg[2], alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  let text = attributed(spec.body, scale: CGFloat(spec.scale ?? 3))
  let setter = CTFramesetterCreateWithAttributedString(text)
  let inset = CGFloat(w) * 0.07
  let path = CGPath(rect: CGRect(x: 0, y: 0, width: w, height: h).insetBy(dx: inset, dy: inset), transform: nil)
  CTFrameDraw(CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil), ctx)
  let url = URL(fileURLWithPath: spec.out) as CFURL
  let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
}

let specs = try JSONDecoder().decode([Spec].self, from: FileHandle.standardInput.readDataToEndOfFile())
for spec in specs {
  spec.kind == "pdf" ? writePDF(spec) : writePNG(spec)
}
