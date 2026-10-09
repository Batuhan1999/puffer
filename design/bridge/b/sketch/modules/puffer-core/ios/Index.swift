import Accelerate
import Foundation

// A port of `src/puffer.ts`, behaviour for behaviour: N x 768 Float32 matrix, MRL-truncated normalized views
// per Dim, brute-force dot products (vDSP), BM25 over passage text, hybrid = similarity + 0.1 x normalized BM25,
// relative cutoff (top similarity minus 0.1, at least 3 hits). Vectors live here and in Embedder only.
// The parity test records JS results for a fixture library and asserts identical rankings from this port.

final class Index {
  private(set) var items: [Item] = []
  private(set) var counts: [Kind: Int] = [.photo: 0, .passage: 0]
  private var rows: [ItemId: Int] = [:]
  private var full: [Float] = []
  private var views: [Dim: [Float]] = [:]
  private var keywords = Bm25()

  var size: Int { items.count }

  func has(_ id: ItemId) -> Bool { fatalError("not implemented") }
  func add(_ item: Item, _ vec: [Float]) { fatalError("not implemented") }
  func clear() { fatalError("not implemented") }
  func vector(of id: ItemId) -> [Float]? { fatalError("not implemented") }
  func bytes(at dim: Dim) -> Int { fatalError("not implemented") }

  func vectorTopK(_ query: [Float], dim: Dim, k: Int) -> [Scored] { fatalError("not implemented") }
  func rerank(_ query: [Float], rows: [Int]) -> [Scored] { fatalError("not implemented") }
  func similarity(_ query: [Float], row: Int) -> Float { fatalError("not implemented") }
  func keywordTopK(_ text: String, k: Int) -> [Scored] { fatalError("not implemented") }

  /// Same shape as the JS `search`, with `embed` injected so the pure ranking logic has no engine dependency.
  func search(_ query: Query, _ options: SearchOptions, embed: (String) async throws -> [Float]) async throws -> SearchResult {
    fatalError("not implemented")
  }
}

struct Scored { let row: Int; let score: Float }

final class Bm25 {
  func add(row: Int, text: String) { fatalError("not implemented") }
  func search(_ text: String, k: Int) -> [Scored] { fatalError("not implemented") }
  /// Term positions are kept so `Consent.excerpt` can window the snippet around the best-matching terms.
  func matchedRanges(row: Int, query: String, in text: String) -> [Range<String.Index>] { fatalError("not implemented") }
}
