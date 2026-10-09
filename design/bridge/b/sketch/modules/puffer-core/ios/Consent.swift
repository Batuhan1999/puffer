import Foundation

// The consent boundary. This is the only code that constructs a `Disclosure`, so whatever JS or the relay
// does afterwards, nothing richer than a Disclosure exists to forward. Pure functions over domain values.

enum Consent {
  static let candidates = 6
  static let offeredRank = 3
  static let excerptChars = 400

  /// Passages near the top are offered by default; photos never are, because an image is the riskiest thing to share.
  static func offered(_ item: Item, rank: Int) -> Bool { fatalError("not implemented") }

  /// Builds the proposal for a request.
  /// - `hits`: the engine's search for the question (hybrid, user's prefs).
  /// - `membership`: for each granted collection of the agent, the set of item ids its description query ranks,
  ///   minus hidden ids. Computed by the engine with the same `search` the UI uses, so "in a collection" means
  ///   exactly what the Collections screen shows.
  /// `auto` is true iff there is at least one offered candidate and every offered candidate is covered. Partial
  /// coverage goes to review, on purpose: the user sees the uncovered item and decides.
  static func propose(
    request: IncomingRequest,
    hits: [Hit],
    membership: [CollectionId: Set<ItemId>],
    excerpt: (Item) -> Disclosure
  ) -> Proposal { fatalError("not implemented") }

  /// A snippet is the excerpt the user saw in the review screen, nothing more. `source` is the file name only,
  /// never a path. For photos, `preview` in the proposal is the thumbnail; `release` re-encodes the original as
  /// JPEG only for ids the user turned on.
  static func excerpt(_ item: Item, matched: [Range<String.Index>]) -> Disclosure { fatalError("not implemented") }

  /// Validates `itemIds` against the proposal (unknown ids are rejected, not silently dropped) and returns the
  /// disclosures to release. Rejecting keeps a buggy caller from widening a release past what was reviewed.
  static func release(_ proposal: Proposal, itemIds: [ItemId], loadJpeg: (Item) throws -> Data) throws -> [Disclosure] {
    fatalError("not implemented")
  }
}
