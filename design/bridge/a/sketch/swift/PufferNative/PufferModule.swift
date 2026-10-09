// modules/puffer-native/ios/PufferModule.swift
// The JS boundary. Thin: parse Records into domain types, call Engine or Bridge, encode results.
// Replaces GemmaEmbedModule.swift; the folder functions (pickFolder, listFolders, scanFolder,
// readFolderText, copyFolderFile, pdfText) move here unchanged. load/embedTexts/embedImage are deleted:
// JS never sees a vector again.

import ExpoModulesCore

public class PufferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Puffer")

    Constants(["modelPath": Engine.modelURL.absoluteString])

    /// One event for every change. Payload: { topic: "items" | "policy" | "requests" | "relay", revision }.
    /// JS refetches the slice it renders. Fed by Engine revisions and Bridge.changes.
    Events("onChange")

    // engine
    AsyncFunction("start") { () async throws -> [String: Any] in fatalError("not implemented") }
    AsyncFunction("status") { () async -> [String: Any] in fatalError("not implemented") }
    AsyncFunction("search") { (query: QueryRecord, options: OptionsRecord) async throws -> [String: Any] in fatalError("not implemented") }
    AsyncFunction("items") { () async -> [[String: Any]] in fatalError("not implemented") }   // all cards, for the library lists
    AsyncFunction("addPassages") { (batch: [PassageRecord]) async throws -> Int in fatalError("not implemented") }
    AsyncFunction("addImage") { (image: ImageRecord) async throws in fatalError("not implemented") }
    AsyncFunction("clear") { () async throws in fatalError("not implemented") }

    // bridge
    AsyncFunction("snapshot") { () async -> [String: Any] in fatalError("not implemented") }
    AsyncFunction("edit") { (edit: [String: Any]) async throws in fatalError("not implemented") }   // parsed into PolicyEdit here
    AsyncFunction("members") { (collectionId: String) async throws -> [[String: Any]] in fatalError("not implemented") }
    AsyncFunction("connectAgent") { (name: String) async throws -> [String: Any] in fatalError("not implemented") }
    AsyncFunction("pair") { (link: URL) async throws in fatalError("not implemented") }
    AsyncFunction("unpair") { () async throws in fatalError("not implemented") }
    AsyncFunction("decide") { (requestId: String, decision: DecisionRecord) async throws in fatalError("not implemented") }

    // folders: unchanged from GemmaEmbedModule
  }
}

struct QueryRecord: Record {
  @Field var kind: String = "text"          // "text" | "like"
  @Field var text: String? = nil
  @Field var itemId: String? = nil
}

struct OptionsRecord: Record {
  @Field var mode: String = "hybrid"
  @Field var dim: Int = 256
  @Field var rerank: Bool = true
}

struct PassageRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var sourceUri: String = ""
  @Field var addedAt: Double = 0
}

struct ImageRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var sourceUri: String = ""
  @Field var addedAt: Double = 0
  @Field var embedJpegUri: String = ""
  @Field var thumbName: String = ""
}

struct DecisionRecord: Record {
  @Field var kind: String = "deny"          // "share" | "deny"
  @Field var itemIds: [String] = []
}
