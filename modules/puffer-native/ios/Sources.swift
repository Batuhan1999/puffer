import Foundation
import UIKit

struct SourceSummary: Sendable {
  var files = 0
  var updated = 0
  var removed = 0
  var failed = 0

  var changed: Bool { files + updated + removed > 0 }
}

/// Where file indexing stands, for the Folders screen. Sources owns the one live value and posts it, throttled.
struct IndexProgress: Sendable {
  enum Phase: Sendable, Equatable {
    case idle
    case waitingForModel
    case readingFiles
    /// The app left the foreground mid-run. It continues when Puffer is open again, or in the background while
    /// charging: `.charging` when the phone is not plugged in, `.foreground` when it already is.
    case paused(until: Resume)

    var reading: Bool { self == .readingFiles }
  }

  enum Resume: String, Sendable { case foreground, charging }

  struct Tally: Sendable {
    var done = 0
    var total = 0
    var failed = 0
    var left: Int { max(0, total - done - failed) }
  }

  static let notification = Notification.Name("dev.local.puffer.indexProgress")

  var phase = Phase.idle
  var files = Tally()
}

/// Keeps the index in step with the granted folders and Shared with Puffer, and the notes, whenever the app runs and in
/// background refresh. Item ids are the ones the former JS ingest minted, so existing rows are skipped and overlapping
/// passes converge. New, changed and missing files become change events in PufferEngine.
actor Sources {
  static let shared = Sources()

  private var running: Task<SourceSummary, Never>?
  private var again = false
  private var caughtUp = false
  private var progress = IndexProgress()
  private var foreground = false
  private var keptAwake = false
  private var lastSent = Date.distantPast
  private var trailing = false
  private static let publishInterval: TimeInterval = 0.25

  var behind: Bool { !caughtUp && FileManager.default.fileExists(atPath: PufferEngine.modelURL.path) }

  var snapshot: IndexProgress { progress }

  func setForeground(_ value: Bool) {
    foreground = value
    publish()
  }

  /// The app is about to suspend, or the background task ran out. A run in progress waits.
  func pause() async {
    guard progress.phase.reading else { return }
    progress.phase = .paused(until: await Self.onPower() ? .foreground : .charging)
    send()
  }

  @MainActor private static func onPower() -> Bool {
    UIDevice.current.isBatteryMonitoringEnabled = true
    return [.charging, .full].contains(UIDevice.current.batteryState)
  }

  private func update(_ change: (inout IndexProgress) -> Void) {
    change(&progress)
    publish()
  }

  /// At most one event per `publishInterval`; the last change in a burst is sent when the interval ends.
  private func publish() {
    let wait = Self.publishInterval - Date().timeIntervalSince(lastSent)
    if wait <= 0 { return send() }
    guard !trailing else { return }
    trailing = true
    Task {
      try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
      self.trailing = false
      self.send()
    }
  }

  /// Also keeps the screen on while a run reads in the foreground, so auto-lock does not suspend a first run.
  private func send() {
    lastSent = Date()
    NotificationCenter.default.post(name: IndexProgress.notification, object: nil, userInfo: ["progress": progress])
    let awake = foreground && progress.phase.reading
    guard awake != keptAwake else { return }
    keptAwake = awake
    Task { @MainActor in UIApplication.shared.isIdleTimerDisabled = awake }
  }

  /// Single flight. A call during a pass asks for one more pass after it, so a change that lands mid-pass
  /// is not lost.
  @discardableResult
  func catchUp() async -> SourceSummary {
    if let running {
      again = true
      return await running.value
    }
    let task = Task { await self.passes() }
    running = task
    let summary = await task.value
    if running == task { running = nil }
    return summary
  }

  func stop() {
    running?.cancel()
  }

  private func passes() async -> SourceSummary {
    var total = SourceSummary()
    var finished = false
    var modelReady = true
    caughtUp = false
    repeat {
      again = false
      guard (try? await PufferEngine.shared.start()) != nil, case .ready = await PufferEngine.shared.status().model else {
        modelReady = false
        break
      }
      do {
        try await PufferEngine.shared.reembedPassages()
      } catch {
        pufferLog.error("passages not re-embedded: \(error.localizedDescription, privacy: .public)")
      }
      let summary = await syncFolders(await PufferEngine.shared.documents())
      total.files += summary.files
      total.updated += summary.updated
      total.removed += summary.removed
      total.failed += summary.failed
      await NoteIndexer.shared.run()
      finished = !Task.isCancelled
    } while again && !Task.isCancelled
    caughtUp = finished
    if !modelReady {
      update { $0.phase = .waitingForModel }
    } else if finished {
      update { $0.phase = .idle }
    } else {
      await pause()
    }
    if total.changed || total.failed > 0 {
      pufferLog.notice("sources: \(total.files) files added, \(total.updated) updated, \(total.removed) removed, \(total.failed) failed")
    }
    if total.changed { await Bridge.shared.libraryChanged() }
    return total
  }

  // MARK: folders

  private func syncFolders(_ stored: [String: [ItemID]]) async -> SourceSummary {
    var summary = SourceSummary()
    let store = FolderStore()
    var listed: [String: Set<String>] = [:]
    var complete: [String: Bool] = [:]
    let known = await PufferEngine.shared.storedMetadata()
    var backfill: [String: ItemMetadata] = [:]
    update { $0.phase = .readingFiles }
    var found: [(root: FolderRoot, file: FolderFile)] = []
    for root in store.roots() where !Task.isCancelled {
      do {
        let scan = try store.scan(root.id)
        complete[root.name] = (complete[root.name] ?? true) && scan.complete
        found += scan.files.map { (root: root, file: $0) }
      } catch {
        complete[root.name] = false
        summary.failed += 1
      }
    }
    var pending: [(root: FolderRoot, file: FolderFile, sourceUri: String, key: String)] = []
    for (root, file) in found where !Task.isCancelled {
      let sourceUri = "folder:\(root.name)/\(file.path)"
      listed[root.name, default: []].insert(sourceUri)
      let key = "file:" + Self.fnv1a("\(root.id)/\(file.path):\(file.size):\(Self.jsNumber(file.modified))")
      guard let storedUri = await PufferEngine.shared.sourceUri(of: ItemID(rawValue: "\(key):0")) else {
        pending.append((root, file, sourceUri, key))
        continue
      }
      // Stored under an older name for this root, for example before a display-name change. Relabeling clears
      // the metadata, which names the source.
      if storedUri != sourceUri { try? await PufferEngine.shared.relabel(from: storedUri, to: sourceUri) }
      if storedUri != sourceUri || known[sourceUri] == nil {
        backfill[sourceUri] = .file(store.metadata(root, file))
      }
    }
    update { $0.files = .init(done: found.count - pending.count, total: found.count) }
    for (root, file, sourceUri, key) in pending where !Task.isCancelled && store.contains(root.id) {
      let previous = stored[sourceUri] ?? []
      do {
        let pages = try store.readText(root.id, file.path)
        let passages = Chunker.passages(key: key, name: file.name, isPdf: file.kind == .pdf, pages: pages, sourceUri: sourceUri)
        let document = TextDocument(passages: passages, metadata: .file(store.metadata(root, file)), replacing: previous)
        let changed = try await PufferEngine.shared.putTexts([document]) > 0
        if changed, previous.isEmpty { summary.files += 1 } else if changed { summary.updated += 1 }
        update { $0.files.done += 1 }
      } catch {
        summary.failed += 1
        update { $0.files.failed += 1 }
        pufferLog.error("file \(file.path, privacy: .public) skipped: \(error.localizedDescription, privacy: .public)")
      }
    }
    do {
      try await PufferEngine.shared.setMetadata(backfill)
    } catch {
      pufferLog.error("file metadata not saved: \(error.localizedDescription, privacy: .public)")
    }
    guard !Task.isCancelled else { return summary }
    // A source the user removed: no root has its name any more. Read now, after relabeling moved renamed roots.
    let names = Set(store.roots().map(\.name))
    let orphaned = await PufferEngine.shared.documents().filter { uri, _ in
      uri.hasPrefix("folder:") && !names.contains(String(uri.dropFirst("folder:".count).prefix { $0 != "/" }))
    }
    if let removed = try? await PufferEngine.shared.remove(documents: Array(orphaned.values)) { summary.removed += removed }
    for (name, finished) in complete where finished {
      let prefix = "folder:\(name)/"
      let now = listed[name] ?? []
      let gone = stored.filter { $0.key.hasPrefix(prefix) && !now.contains($0.key) }.map(\.value)
      if let removed = try? await PufferEngine.shared.remove(documents: gone) { summary.removed += removed }
    }
    return summary
  }

  /// FNV-1a over UTF-16 code units, as the former JS ingest keyed folder files.
  static func fnv1a(_ text: String) -> String {
    var hash: UInt32 = 0x811c9dc5
    for unit in text.utf16 {
      hash ^= UInt32(unit)
      hash = hash &* 0x01000193
    }
    return String(hash, radix: 16)
  }

  /// A Double printed the way JavaScript prints a number, so keys match the ones JS wrote.
  static func jsNumber(_ value: Double) -> String {
    if value == value.rounded(), abs(value) < 1e21 { return String(Int64(value)) }
    return "\(value)"
  }
}

/// Passages of at most 800 UTF-16 units, split on blank lines, the same rule as the JS document import.
enum Chunker {
  static let size = 800

  static func passages(key: String, name: String, isPdf: Bool, pages: [String], sourceUri: String) -> [NewPassage] {
    var out: [NewPassage] = []
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    for (index, page) in pages.enumerated() {
      for text in chunk(page) {
        out.append(NewPassage(
          id: ItemID(rawValue: "\(key):\(out.count)"), title: isPdf ? "\(name) p.\(index + 1)" : name, text: text,
          sourceUri: sourceUri, addedAtMs: now))
      }
    }
    return out
  }

  static func chunk(_ text: String) -> [String] {
    let paragraphs = splitBlankLines(text)
      .map { $0.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .flatMap(splitLong)
    var out: [String] = []
    var current = ""
    for paragraph in paragraphs {
      if !current.isEmpty, current.utf16.count + paragraph.utf16.count + 1 > size {
        out.append(current)
        current = paragraph
      } else {
        current = current.isEmpty ? paragraph : "\(current)\n\(paragraph)"
      }
    }
    if !current.isEmpty { out.append(current) }
    return out
  }

  private static let blankLine = try! NSRegularExpression(pattern: "\\n\\s*\\n")

  /// `text.split(/\n\s*\n/)` in JS.
  static func splitBlankLines(_ text: String) -> [String] {
    let ns = text as NSString
    var out: [String] = []
    var start = 0
    for match in blankLine.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      out.append(ns.substring(with: NSRange(location: start, length: match.range.location - start)))
      start = match.range.location + match.range.length
    }
    out.append(ns.substring(from: start))
    return out
  }

  static func splitLong(_ paragraph: String) -> [String] {
    var parts: [String] = []
    var rest = paragraph as NSString
    while rest.length > size {
      let space = rest.range(of: " ", options: .backwards, range: NSRange(location: 0, length: min(size + 1, rest.length))).location
      let cut = space != NSNotFound && space > size / 2 ? space : size
      parts.append(rest.substring(to: cut).trimmingCharacters(in: .whitespacesAndNewlines))
      rest = rest.substring(from: cut).trimmingCharacters(in: .whitespacesAndNewlines) as NSString
    }
    if rest.length > 0 { parts.append(rest as String) }
    return parts
  }
}
