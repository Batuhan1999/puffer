import Foundation

// `EmbedRuntime` from GemmaEmbedModule.swift, moved verbatim and given the query/passage prompt formats that
// `src/model.ts` used to add in JS. Prompt formatting moves here so the engine, the intents and the bridge all
// embed the same way; JS no longer formats prompts because JS no longer embeds.

actor Embedder {
  func load(_ modelPath: String) async throws -> Backend { fatalError("not implemented") }

  /// `task: search result | query: {q}`. Cached per text for collection queries, which repeat on every request.
  func embedQuery(_ text: String) async throws -> [Float] { fatalError("not implemented") }
  /// `title: {t} | text: {c}`
  func embedPassages(_ passages: [(title: String, text: String)]) async throws -> [[Float]] { fatalError("not implemented") }
  func embedImage(path: String) async throws -> [Float] { fatalError("not implemented") }
}
