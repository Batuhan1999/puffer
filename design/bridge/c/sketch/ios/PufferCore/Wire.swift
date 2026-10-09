import Foundation

// Codable mirror of relay/protocol.ts. Internal to the pod: no wire type is visible to JS or to App Intents.
// Decoding happens once, in Bridge, into AskRecord. Golden files in sketch/contract/ are decoded by both test suites.
enum SharedItemWire: Codable, Sendable {
  case passage(ref: String, title: String, snippet: String)
  case photo(ref: String, title: String, jpegBase64: String)
}
enum Outcome: Codable, Sendable {
  case shared(via: String, items: [SharedItemWire], photosWithheld: Int)
  case denied
}
struct AnswerWire: Codable, Sendable { let requestId: String; let outcome: Outcome; let answeredAt: Double }
