import Foundation

// The enforcement point. Everything that can leave the phone passes through this file.
//
// Invariant, encoded in types: only an `Approval` can be turned into an outbound payload, and `Approval` can only be
// created here, by two paths: the Policy auto path, and an explicit user decision on a stored proposal.
// `init` is fileprivate, so any other file that tries to build an Approval fails to compile.
// Egress reads item text and thumbnails from the index at send time. It never accepts content from callers, JS included.

struct Approval {
  let requestId: RequestID
  let via: Via
  fileprivate let itemIds: [ItemID]     // texts and photos, all drawn from the stored proposal
  fileprivate let imageIds: Set<ItemID> // subset of itemIds whose bytes may leave
  fileprivate let photosWithheld: Int
  enum Via: String { case auto, user }

  fileprivate init(requestId: RequestID, via: Via, itemIds: [ItemID], imageIds: Set<ItemID>, photosWithheld: Int) {
    self.requestId = requestId; self.via = via; self.itemIds = itemIds; self.imageIds = imageIds; self.photosWithheld = photosWithheld
  }
}

enum ConsentError: Error { case notOffered(ItemID), alreadyAnswered, unknownRequest, expired }

actor ConsentGate {
  init(index: PufferIndex, store: Store) { fatalError("not implemented") }

  /// Runs scope -> search -> disposition for a received ask and records the result on the request row.
  /// Returns an Approval for .auto, or nil when the request now waits for the user.
  func evaluate(_ ask: AskRecord) async throws -> Approval? { fatalError("not implemented") }

  /// The user's decision. Throws .notOffered if any id is outside the stored `offered` set (a JS bug cannot widen the share).
  /// Images need their own ids in `imageIds`. A second call on an answered request throws .alreadyAnswered.
  func userApproved(_ id: RequestID, itemIds: [ItemID], imageIds: Set<ItemID>) async throws -> Approval { fatalError("not implemented") }
  func userDenied(_ id: RequestID) async throws { fatalError("not implemented") }
}

enum Egress {
  /// The only producer of wire content. Text is clipped to LIMITS.snippetChars, photos are re-encoded to a JPEG under
  /// LIMITS.imageBytes, ids become per-request refs.
  static func materialize(_ approval: Approval, index: PufferIndex) async throws -> Outcome { fatalError("not implemented") }
}
