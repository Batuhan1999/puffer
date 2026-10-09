import CoreSpotlight
import Foundation

// Spotlight is a derived view of the index, never a second store.
// reconcile() diffs the donated set against PufferIndex by revision and item id, then donates or deletes.
// Runs after ingest batches, at launch, and when the toggle changes. Turning the toggle off deletes everything donated.
// Setting is opt-in (default off): donated text appears in device Spotlight, which is a wider audience than the app.
// Donation covers titles and a short snippet. Vectors never go to Spotlight.

enum SpotlightMirror {
  static func reconcile(index: PufferIndex) async throws { fatalError("not implemented") }
  static func removeAll() async throws { fatalError("not implemented") }
}

/// Entry for App Intents. Returns hits fast enough for Siri: keyword fallback after the deadline.
enum SystemSearch {
  static let embedDeadline: Duration = .seconds(2)
  static func search(_ text: String, limit: Int) async throws -> [ItemRecord] { fatalError("not implemented") }
  static func recent(limit: Int) async throws -> [ItemRecord] { fatalError("not implemented") }
  static func lookup(_ ids: [ItemID]) async throws -> [ItemRecord] { fatalError("not implemented") }
}
