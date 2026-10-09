import CryptoKit
import ExpoModulesCore
import PDFKit
import UIKit
import UniformTypeIdentifiers

final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
  private let done: (URL?) -> Void

  init(_ done: @escaping (URL?) -> Void) {
    self.done = done
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    done(urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    done(nil)
  }
}

enum FileKind: String, Sendable { case text, pdf }

struct FolderFile: Sendable {
  let path: String
  let name: String
  let kind: FileKind
  let size: Int
  /// Milliseconds since 1970.
  let modified: Double
  let created: Date?
}

/// `complete` is false when the walk stopped at the file limit, so a missing file may only be unlisted.
struct FolderScan: Sendable {
  let files: [FolderFile]
  let complete: Bool
}

/// A place Sources reads files from: a folder the user granted, or one Puffer owns (`OwnedFolder`).
struct FolderRoot: Sendable {
  let id: String
  let name: String
}

final class FolderStore {
  private static let key = "puffer.folders"
  private static let limit = 20_000
  private static let kinds: [String: FileKind] = ["txt": .text, "md": .text, "markdown": .text, "pdf": .pdf]

  static func kind(of url: URL) -> FileKind? { kinds[url.pathExtension.lowercased()] }

  private var saved: [String: [String: String]] {
    get { UserDefaults.standard.dictionary(forKey: Self.key) as? [String: [String: String]] ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: Self.key) }
  }

  func add(_ url: URL) throws -> [String: String] {
    guard url.startAccessingSecurityScopedResource() else {
      throw Exception(name: "FolderDenied", description: "No access to \(url.lastPathComponent)")
    }
    defer { url.stopAccessingSecurityScopedResource() }
    let path = url.standardizedFileURL.path
    var all = saved
    if let covering = Self.grant(containing: path, in: all) {
      return ["id": covering.key, "name": covering.value["name"] ?? ""]
    }
    let bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
    let name = Self.displayName(url)
    let id = all.first(where: { $0.value["path"] == path })?.key ?? UUID().uuidString
    all[id] = ["name": name, "path": path, "bookmark": bookmark.base64EncodedString()]
    saved = all
    return ["id": id, "name": name]
  }

  private static func grant(containing path: String, in all: [String: [String: String]]) -> (key: String, value: [String: String])? {
    all.first { path.hasPrefix(($0.value["path"] ?? "") + "/") }
  }

  /// iOS reports "File Provider Storage", the directory name, as the display name of the top of On My iPhone.
  private static func displayName(_ url: URL) -> String {
    switch url.lastPathComponent {
    case "File Provider Storage": "On My iPhone"
    case "com~apple~CloudDocs": "iCloud Drive"
    default: url.lastPathComponent
    }
  }

  /// Grants to show. A grant inside another grant is still scanned on its own, but the outer one already names it.
  func list() -> [[String: String]] {
    let all = saved
    return all.compactMap { key, entry in
      guard Self.grant(containing: entry["path"] ?? "", in: all) == nil else { return nil }
      return ["id": key, "name": entry["name"] ?? ""]
    }
  }

  /// Forgets the grant and its bookmark. Grants nested inside it stay; the files are never touched. The next Sources
  /// pass removes what Puffer indexed from it.
  func remove(_ id: String) {
    var all = saved
    all[id] = nil
    saved = all
  }

  func contains(_ id: String) -> Bool { saved[id] != nil || OwnedFolder.all().contains { $0.root.id == id } }

  /// Every place to scan: all saved grants, nested ones included, and the folders Puffer owns.
  func roots() -> [FolderRoot] {
    saved.map { FolderRoot(id: $0.key, name: $0.value["name"] ?? "") } + OwnedFolder.all().map(\.root)
  }

  func scan(_ id: String) throws -> FolderScan {
    let ownedElsewhere = pathsOfGrantsInside(id)
    return try withFolder(id) { root in
      let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey, .creationDateKey]
      guard let walker = FileManager.default.enumerator(
        at: root, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants])
      else { return FolderScan(files: [], complete: true) }
      let base = root.standardizedFileURL.path
      var out: [FolderFile] = []
      for case let file as URL in walker {
        if out.count >= Self.limit { return FolderScan(files: out, complete: false) }
        let path = String(file.standardizedFileURL.path.dropFirst(base.count + 1))
        if ownedElsewhere.contains(path) {
          walker.skipDescendants()
          continue
        }
        guard let kind = Self.kind(of: file),
          let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true
        else { continue }
        out.append(FolderFile(
          path: path, name: file.lastPathComponent, kind: kind, size: values.fileSize ?? 0,
          modified: (values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000, created: values.creationDate))
      }
      return FolderScan(files: out, complete: true)
    }
  }

  private func pathsOfGrantsInside(_ id: String) -> Set<String> {
    let all = saved
    guard let base = all[id]?["path"] else { return [] }
    return Set(all.compactMap { key, entry in
      guard key != id, let path = entry["path"], path.hasPrefix(base + "/") else { return nil }
      return String(path.dropFirst(base.count + 1))
    })
  }

  func readText(_ id: String, _ path: String) throws -> [String] {
    try withFolder(id) { root in
      try coordinated(root.appendingPathComponent(path)) { url in
        if url.pathExtension.lowercased() == "pdf" {
          guard let document = PDFDocument(url: url) else {
            throw Exception(name: "PdfUnreadable", description: "Cannot open \(url.lastPathComponent)")
          }
          return (0..<document.pageCount).map { document.page(at: $0)?.string ?? "" }
        }
        if let utf8 = try? String(contentsOf: url, encoding: .utf8) {
          return [utf8]
        }
        return [try String(contentsOf: url, encoding: .isoLatin1)]
      }
    }
  }

  /// A PDF the file system cannot open still gets the rest.
  func metadata(_ root: FolderRoot, _ file: FolderFile) -> FileMetadata {
    let pdf: PdfAttributes? = file.kind == .pdf
      ? try? withFolder(root.id) { try coordinated($0.appendingPathComponent(file.path)) { PDFDocument(url: $0).map(PdfAttributes.init) } }
      : nil
    let folder = (file.path as NSString).deletingLastPathComponent
    return FileMetadata(
      name: file.name, folder: folder, source: root.name, type: (file.name as NSString).pathExtension.lowercased(),
      created: file.created, modified: file.modified > 0 ? Date(timeIntervalSince1970: file.modified / 1000) : nil,
      size: file.size, pdf: pdf)
  }

  /// The name of the place that already holds a file with exactly these bytes, if any. Only files of the same size
  /// are read. The key is SHA-256 of the bytes: Open In hands over a byte-exact copy.
  func holder(of file: URL) -> String? {
    guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, let digest = try? Self.digest(file) else { return nil }
    for root in roots() {
      guard let scan = try? scan(root.id) else { continue }
      for candidate in scan.files where candidate.size == size {
        let other = try? withFolder(root.id) { try coordinated($0.appendingPathComponent(candidate.path), Self.digest) }
        if other == digest { return root.name }
      }
    }
    return nil
  }

  private static func digest(_ url: URL) throws -> Data {
    Data(SHA256.hash(data: try Data(contentsOf: url, options: .mappedIfSafe)))
  }

  /// The file's bytes for an approved share. Blocks: an iCloud file not on the device gets `timeout` to download through
  /// a coordinated read, then counts as unavailable. Call it off the cooperative pool.
  func readFile(_ id: String, _ path: String, timeout: TimeInterval) -> FileRead {
    let read = try? withFolder(id) { root -> FileRead in
      let url = root.appendingPathComponent(path)
      if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > Egress.fileLimit { return .tooLarge }
      let coordinator = NSFileCoordinator()
      let box = ReadBox()
      let done = DispatchSemaphore(value: 0)
      DispatchQueue.global(qos: .userInitiated).async {
        var error: NSError?
        coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &error) { readable in
          box.result = (try? Data(contentsOf: readable)).map { data in
            data.count > Egress.fileLimit ? .tooLarge : .file(DocumentFile(name: url.lastPathComponent, mimeType: Self.mimeType(url), data: data))
          }
        }
        done.signal()
      }
      guard done.wait(timeout: .now() + timeout) == .success else {
        coordinator.cancel()
        return .unavailable
      }
      return box.result ?? .unavailable
    }
    return read ?? .unavailable
  }

  static func mimeType(_ url: URL) -> String {
    (UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream").lowercased()
  }

  private func withFolder<T>(_ id: String, _ body: (URL) throws -> T) throws -> T {
    if let owned = OwnedFolder.all().first(where: { $0.root.id == id }) {
      try FileManager.default.createDirectory(at: owned.url, withIntermediateDirectories: true)
      return try body(owned.url)
    }
    guard let entry = saved[id], let encoded = entry["bookmark"], let data = Data(base64Encoded: encoded) else {
      throw Exception(name: "UnknownFolder", description: "Folder \(id) is not saved")
    }
    var stale = false
    let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    guard url.startAccessingSecurityScopedResource() else {
      throw Exception(name: "FolderDenied", description: "Access to \(url.lastPathComponent) expired. Pick it again.")
    }
    defer { url.stopAccessingSecurityScopedResource() }
    if stale, let fresh = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
      var all = saved
      all[id]?["bookmark"] = fresh.base64EncodedString()
      saved = all
    }
    return try body(url)
  }

  // Coordinated reads make iCloud Drive download files that are not on the device yet.
  private func coordinated<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
    var coordinationError: NSError?
    var result: Result<T, Error> = .failure(Exception(name: "ReadFailed", description: url.lastPathComponent))
    NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { readable in
      result = Result { try body(readable) }
    }
    if let coordinationError { throw coordinationError }
    return try result.get()
  }
}

/// Written by the coordinated read's thread and read only after it signalled.
private final class ReadBox: @unchecked Sendable {
  var result: FileRead?
}

/// Original files of stored documents, for approved shares.
enum DocumentFiles {
  static let downloadTimeout: TimeInterval = 6

  /// Through the folder grant for `folder:<root name>/<path>`, Shared with Puffer included, which is Puffer's own copy.
  /// A document picked before Shared with Puffer existed is a file URL in Puffer's container.
  static func read(sourceUri: String) async -> FileRead {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async { continuation.resume(returning: readNow(sourceUri)) }
    }
  }

  private static func readNow(_ sourceUri: String) -> FileRead {
    guard sourceUri.hasPrefix("folder:") else {
      guard let url = URL(string: sourceUri), url.isFileURL, let data = try? Data(contentsOf: url) else { return .unavailable }
      return data.count > Egress.fileLimit
        ? .tooLarge : .file(DocumentFile(name: url.lastPathComponent, mimeType: FolderStore.mimeType(url), data: data))
    }
    let rest = sourceUri.dropFirst("folder:".count)
    let name = String(rest.prefix { $0 != "/" })
    let path = String(rest.dropFirst(name.count + 1))
    let store = FolderStore()
    // Two granted folders can share a display name; the first that has the file wins.
    for root in store.roots() where root.name == name {
      let read = store.readFile(root.id, path, timeout: downloadTimeout)
      if case .unavailable = read { continue }
      return read
    }
    return .unavailable
  }
}

/// A folder Puffer owns, in Application Support: backed up, never listed in the Files app. Sources scans it like a
/// granted folder, so its files get `folder:<name>/<file>` source URIs and the folder's name as their source.
struct OwnedFolder: Sendable {
  let root: FolderRoot
  let url: URL

  private static let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]

  /// Files other apps open in Puffer.
  static let shared = OwnedFolder(
    root: FolderRoot(id: "shared", name: DocumentLabel.shared),
    url: support.appendingPathComponent(DocumentLabel.shared, isDirectory: true))

  static func all() -> [OwnedFolder] { [shared] }

  enum Saved { case new, replaced, unchanged }

  /// Puts `name` here with the bytes `write` puts at the URL it is given: a hidden file in this folder, moved in
  /// whole, so a concurrent scan never reads a half-written file. The same bytes as the file already there change
  /// nothing. Other bytes replace it, which the next scan logs as one `updated`.
  func put(_ name: String, modified: Date? = nil, created: Date? = nil, write: (URL) throws -> Void) throws -> Saved {
    let files = FileManager.default
    try files.createDirectory(at: url, withIntermediateDirectories: true)
    let target = url.appendingPathComponent(name)
    let staged = url.appendingPathComponent(".\(UUID().uuidString)")
    try write(staged)
    defer { try? files.removeItem(at: staged) }
    let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
    let old = try? target.resourceValues(forKeys: keys)
    if old != nil, files.contentsEqual(atPath: target.path, andPath: staged.path) { return .unchanged }
    let new = try staged.resourceValues(forKeys: keys)
    // Sources keys a file by size and modification date, so new bytes must change one of them to be read again.
    var date = modified ?? new.contentModificationDate
    if let old, let same = date, old.fileSize == new.fileSize, old.contentModificationDate == same { date = same + 0.001 }
    var attributes: [FileAttributeKey: Any] = [:]
    attributes[.modificationDate] = date
    attributes[.creationDate] = created
    if !attributes.isEmpty { try files.setAttributes(attributes, ofItemAtPath: staged.path) }
    if old != nil {
      _ = try files.replaceItemAt(target, withItemAt: staged, options: .usingNewMetadataOnly)
      return .replaced
    }
    try files.moveItem(at: staged, to: target)
    return .new
  }
}

/// Takes files opened in Puffer from other apps. Markdown, and folders of it (Apple Notes' Export as Markdown), become
/// notes; PDFs and text files go to Shared with Puffer. Keeps a short confirmation per file for the UI.
actor ShareInbox {
  static let shared = ShareInbox()
  private var receipts: [String] = []

  func receive(_ incoming: [URL]) async {
    let engine = PufferEngine.shared
    let before = (try? await engine.recentChanges(limit: 1).first?.seq) ?? 0
    var saved: [(name: String, outcome: OwnedFolder.Saved?)] = []
    for url in incoming {
      let name = url.lastPathComponent
      let scoped = url.startAccessingSecurityScopedResource()
      defer {
        if scoped { url.stopAccessingSecurityScopedResource() }
        Self.dropInboxCopy(url)
      }
      if Self.isMarkdown(url) {
        do {
          let result = try await NoteImport.markdown(url)
          let notes = result.notes == 1 ? "“\((name as NSString).deletingPathExtension)” to Notes" : "\(result.notes) notes"
          let images = result.images == 0 ? "" : " \(result.images) image\(result.images == 1 ? " was" : "s were") not imported."
          receipts.append("Added \(notes).\(images)")
        } catch {
          pufferLog.error("share \(name, privacy: .public) not imported: \(error.localizedDescription, privacy: .public)")
          receipts.append("Puffer could not import “\(name)”")
        }
        continue
      }
      guard FolderStore.kind(of: url) != nil else {
        saved.append((name, nil))
        continue
      }
      do {
        saved.append((name, try Self.save(url)))
      } catch {
        pufferLog.error("share \(name, privacy: .public) not saved: \(error.localizedDescription, privacy: .public)")
        saved.append((name, nil))
      }
    }
    if !saved.isEmpty {
      await Sources.shared.catchUp()
      let logged = ((try? await engine.changes(after: before)) ?? []).filter { $0.source == DocumentLabel.shared }
      let ready = if case .ready = await engine.status().model { true } else { false }
      for (name, outcome) in saved {
        let kind = logged.last { $0.title == name }?.kind
        let receipt = switch (outcome, kind) {
        case (nil, _): "Puffer could not open “\(name)”"
        case (_, .added?): "Added “\(name)” to Puffer"
        case (_, .updated?): "Updated “\(name)” in Puffer"
        case (.unchanged?, _): "“\(name)” is already in Puffer"
        case _ where ready: "Puffer could not read “\(name)”"
        default: "Saved “\(name)”. Puffer reads it once search is ready."
        }
        receipts.append(receipt)
      }
    }
    Changes.post(.shared)
  }

  /// A Markdown file, or a folder that holds one.
  private static func isMarkdown(_ url: URL) -> Bool {
    if ["md", "markdown"].contains(url.pathExtension.lowercased()) { return true }
    guard (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true,
          let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
    else { return false }
    while let file = walker.nextObject() as? URL {
      if ["md", "markdown"].contains(file.pathExtension.lowercased()) { return true }
    }
    return false
  }

  /// iOS copies an opened file into the app (tmp/<bundle id>-Inbox). That copy is ours to delete once taken; a file
  /// elsewhere is not.
  private static func dropInboxCopy(_ url: URL) {
    if url.resolvingSymlinksInPath().path.hasPrefix(URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path) {
      try? FileManager.default.removeItem(at: url)
    }
  }

  /// Copies the file into Shared with Puffer under its own name. Bytes Puffer already reads, there or in a granted
  /// folder, change nothing.
  private static func save(_ incoming: URL) throws -> OwnedFolder.Saved {
    if let holder = FolderStore().holder(of: incoming) {
      pufferLog.notice("share \(incoming.lastPathComponent, privacy: .public): same bytes already in \(holder, privacy: .public)")
      return .unchanged
    }
    return try OwnedFolder.shared.put(incoming.lastPathComponent) { try FileManager.default.copyItem(at: incoming, to: $0) }
  }

  /// Confirmations not shown yet. The UI drains them on launch and on each `shared` change.
  func take() -> [String] {
    defer { receipts = [] }
    return receipts
  }
}
