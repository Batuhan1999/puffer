import Foundation

// Pure functions. No I/O, no clock reads, no state. Unit-testable with plain values.
// This file answers one question: for this agent and this ask, what may be answered without the user?

enum Scope: Equatable {
  /// Search only inside these collections' members, answer without asking, text snippets only.
  case granted(Set<CollectionID>)
  /// Search everything, every item needs the user.
  case everything
}

enum Disposition {
  /// Entire answer is covered by grants. Photos are never auto; they are counted in `photosWithheld`.
  case auto(texts: [ItemID], photosWithheld: Int)
  /// The user reviews. `offered` is the closed set the user may pick from; `preselected` is the default toggle state.
  case review(offered: [ItemID], preselected: Set<ItemID>)
}

enum Policy {
  static let offeredCount = 6
  static let autoLimit = 8
  static let autoPerMinute = 30

  /// agent.revoked or unknown agent => caller never reaches here (Bridge drops the ask).
  /// ask.scope == .broaden, or no grants, or the agent is over its auto rate => .everything.
  static func scope(for ask: AskRecord, agent: AgentRecord, autoAnswersLastMinute: Int) -> Scope { fatalError("not implemented") }

  /// `.granted` + hits => .auto (even when hits are empty: the empty answer carries a note about `broaden`).
  /// `.everything` => .review with the top texts preselected and photos never preselected.
  static func disposition(scope: Scope, hits: [(id: ItemID, kind: ItemKind)]) -> Disposition { fatalError("not implemented") }
}
