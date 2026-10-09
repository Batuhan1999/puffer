import Accelerate

// Pure ranking. A direct port of src/puffer.ts (vector scan, BM25, hybrid fusion, relative cutoff).
// Accelerate does the matrix-vector product. No state, no I/O. Golden fixtures generated from puffer.ts
// before it is deleted pin the port: same corpus, same queries, same top-k order.

struct Scored { let row: Int; let score: Float }

enum Ranking {
  static let candidates = 50
  static let keywordBoost: Float = 0.1
  static let relevanceWindow: Float = 0.1
  static let minHits = 3

  /// `mask == nil` scans every row. A mask is how a granted-collection scope is enforced: rows outside it are never scored.
  static func vectorTopK(matrix: UnsafeBufferPointer<Float>, rows: Int, dim: Int, query: [Float], mask: RowMask?, k: Int) -> [Scored] {
    fatalError("not implemented")
  }
  static func hybrid(vector: [Scored], keyword: [Scored], similarity: (Int) -> Float) -> [Scored] { fatalError("not implemented") }
  static func relevant(_ hits: [(row: Int, similarity: Float?)]) -> [Int] { fatalError("not implemented") }
}

struct RowMask {
  let rows: Set<Int>
  func contains(_ row: Int) -> Bool { rows.contains(row) }
}

struct Bm25 {
  mutating func add(row: Int, text: String) { fatalError("not implemented") }
  func search(_ text: String, k: Int, mask: RowMask?) -> [Scored] { fatalError("not implemented") }
}
