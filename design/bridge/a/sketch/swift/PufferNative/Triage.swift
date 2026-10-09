// modules/puffer-native/ios/Triage.swift
// The consent rule. Pure: no I/O, no clock, no actor. Bridge feeds it a canonical search and the
// agent's granted membership and stores what it returns.

import Foundation

/// A list that cannot be empty, by construction.
struct NonEmpty<Element: Codable & Sendable & Hashable>: Codable, Sendable, Hashable {
  let head: Element
  let tail: [Element]
  var all: [Element] { [head] + tail }
  init?(_ elements: [Element]) { fatalError("not implemented") }
}

/// One row of the review screen, frozen at triage time.
struct Candidate: Codable, Sendable, Hashable {
  let itemID: ItemID
  let kind: ItemKind
  let title: String
  /// First 160 characters of the passage, for the review row. nil for photos.
  let preview: String?
  /// Member of a collection granted to this agent when triage ran.
  let granted: Bool
  /// Switched on by default in review: a passage ranked in the top 3. Photos never are.
  let offered: Bool
}

enum TriageOutcome: Equatable {
  /// No hits at all. Reported as nothing_found without asking; it reveals no content.
  case nothingFound
  /// Every default-offered candidate is a granted passage. Shared without asking.
  case autoShare(NonEmpty<ItemID>)
  /// Anything else. The user decides from exactly these rows.
  case askUser(NonEmpty<Candidate>)
}

enum Triage {
  static let reviewSize = 6
  static let offeredTop = 3

  /// - `hits` come from `Engine.search(question, .canonical)`, already cut by relevance.
  /// - `granted` is the union of `Bridge.members(c)` for every collection granted to the asking agent.
  ///
  /// Rule:
  ///   candidates = hits.prefix(reviewSize)
  ///   offered    = candidates where kind == .passage && rank < offeredTop
  ///   empty candidates                         -> .nothingFound
  ///   offered non-empty and offered ⊆ granted  -> .autoShare(offered)
  ///   otherwise                                -> .askUser(candidates with granted/offered flags)
  /// Photos are never in `offered`, so a photo can only leave through `.askUser` and a user toggle.
  static func decide(hits: [Hit], granted: Set<ItemID>) -> TriageOutcome { fatalError("not implemented") }

  /// A user's picks must come from the frozen candidates. Anything else is dropped, not shared.
  static func approved(_ picked: Set<ItemID>, from candidates: NonEmpty<Candidate>) -> [Candidate] { fatalError("not implemented") }
}
