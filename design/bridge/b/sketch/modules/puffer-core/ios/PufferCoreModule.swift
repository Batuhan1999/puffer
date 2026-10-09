import ExpoModulesCore

// The JS face of the engine. Thin: every function forwards to `PufferEngine.shared` and converts domain values
// to Records. The module also implements `EngineSink`, so the engine can notify JS of changes and open requests.
// Folder picking stays here because it needs `appContext` for a presenting view controller.

public class PufferCoreModule: Module, EngineSink {
  private var folderPicker: FolderPickerDelegate?

  public func definition() -> ModuleDefinition {
    Name("PufferCore")
    Events("onOpenItem", "onChange")

    OnCreate { /* Task { await PufferEngine.shared.attach(sink: self) } */ }
    OnDestroy { /* Task { await PufferEngine.shared.detachSink() } */ }

    AsyncFunction("load") { (model: URL) async throws -> String in fatalError("not implemented") }

    AsyncFunction("addPassages") { (inputs: [PassageRecord]) async throws -> Int in fatalError("not implemented") }
    AsyncFunction("addPhoto") { (input: PhotoRecord) async throws -> Bool in fatalError("not implemented") }
    Function("has") { (id: String) -> Bool in fatalError("not implemented") }
    AsyncFunction("items") { () async throws -> [ItemRecord] in fatalError("not implemented") }
    Function("counts") { () -> [String: Int] in fatalError("not implemented") }
    AsyncFunction("clear") { () async throws in fatalError("not implemented") }
    AsyncFunction("search") { (query: QueryRecord, options: SearchOptionsRecord) async throws -> SearchResultRecord in fatalError("not implemented") }

    AsyncFunction("collections") { () async throws -> [CollectionRecord] in fatalError("not implemented") }
    AsyncFunction("saveCollection") { (c: CollectionInputRecord) async throws in fatalError("not implemented") }
    AsyncFunction("removeCollection") { (id: String) async throws in fatalError("not implemented") }
    AsyncFunction("hideFromCollection") { (id: String, itemId: String) async throws in fatalError("not implemented") }

    AsyncFunction("agents") { () async throws -> [AgentRecord] in fatalError("not implemented") }
    AsyncFunction("createAgent") { (input: AgentInputRecord) async throws -> CreatedAgentRecord in fatalError("not implemented") }
    AsyncFunction("removeAgent") { (id: String) async throws in fatalError("not implemented") }
    AsyncFunction("setGrant") { (agentId: String, collectionId: String, allowed: Bool) async throws in fatalError("not implemented") }

    AsyncFunction("prepare") { (input: IncomingRequestRecord) async throws -> ProposalRecord in fatalError("not implemented") }
    AsyncFunction("release") { (id: String, itemIds: [String]) async throws -> OutcomeRecord in fatalError("not implemented") }
    AsyncFunction("deny") { (id: String) async throws -> OutcomeRecord in fatalError("not implemented") }
    AsyncFunction("requests") { () async throws -> [BridgeRequestRecord] in fatalError("not implemented") }

    Function("takePendingOpen") { () -> String? in fatalError("not implemented") }

    AsyncFunction("pickFolder") { (promise: Promise) in fatalError("not implemented") }.runOnQueue(.main)
    AsyncFunction("listFolders") { () -> [[String: String]] in fatalError("not implemented") }
    AsyncFunction("scanFolder") { (id: String) throws -> [[String: Any]] in fatalError("not implemented") }
    AsyncFunction("readFolderText") { (id: String, path: String) throws -> [String] in fatalError("not implemented") }
    AsyncFunction("copyFolderFile") { (id: String, path: String) throws -> String in fatalError("not implemented") }
    AsyncFunction("pdfText") { (pdf: URL) throws -> [String] in fatalError("not implemented") }
  }

  // EngineSink
  public func changed(_ tables: Set<Table>) { fatalError("not implemented") }
  public func openItem(_ id: ItemId) { fatalError("not implemented") }
}

// Records are the JS-facing shapes. They mirror Domain.swift one to one; the TS declaration mirrors them.
// A JSON fixture test asserts the three agree (see DESIGN.md, hand-synced list).
struct PassageRecord: Record { @Field var id = ""; @Field var title = ""; @Field var text = ""; @Field var sourceUri = ""; @Field var addedAt = 0.0 }
struct PhotoRecord: Record { @Field var id = ""; @Field var title = ""; @Field var sourceUri = ""; @Field var jpegUri = ""; @Field var thumbName = ""; @Field var addedAt = 0.0 }
struct ItemRecord: Record { @Field var id = ""; @Field var kind = ""; @Field var title = ""; @Field var text: String? = nil; @Field var sourceUri = ""; @Field var thumbUri: String? = nil; @Field var addedAt = 0.0 }
struct QueryRecord: Record { @Field var kind = "text"; @Field var text: String? = nil; @Field var itemId: String? = nil }
struct SearchOptionsRecord: Record { @Field var mode = "hybrid"; @Field var dim = 256; @Field var rerank = true }
struct SearchResultRecord: Record { @Field var hits: [HitRecord] = []; @Field var timings: TimingsRecord = TimingsRecord() }
struct HitRecord: Record { @Field var item = ItemRecord(); @Field var score = 0.0; @Field var similarity: Double? = nil }
struct TimingsRecord: Record { @Field var embedMs: Double? = nil; @Field var scanMs: Double? = nil; @Field var rerankMs: Double? = nil; @Field var keywordMs: Double? = nil; @Field var n = 0; @Field var dim = 256; @Field var indexBytes = 0 }
struct CollectionRecord: Record { @Field var id = ""; @Field var name = ""; @Field var query = ""; @Field var symbol = ""; @Field var hidden: [String] = [] }
struct CollectionInputRecord: Record { @Field var id = ""; @Field var name = ""; @Field var query = ""; @Field var symbol = "" }
struct AgentRecord: Record { @Field var id = ""; @Field var name = ""; @Field var role = ""; @Field var symbol = ""; @Field var createdAt = 0.0; @Field var grants: [String] = [] }
struct AgentInputRecord: Record { @Field var name = ""; @Field var role = ""; @Field var symbol = "" }
struct CreatedAgentRecord: Record { @Field var agent = AgentRecord(); @Field var secret = ""; @Field var tokenHash = "" }
struct IncomingRequestRecord: Record { @Field var id = ""; @Field var agentId = ""; @Field var question = ""; @Field var receivedAt = 0.0 }
struct DisclosureRecord: Record { @Field var kind = "snippet"; @Field var itemId = ""; @Field var title = ""; @Field var excerpt: String? = nil; @Field var source: String? = nil; @Field var mimeType: String? = nil; @Field var base64: String? = nil }
struct CandidateRecord: Record { @Field var item = ItemRecord(); @Field var rank = 0; @Field var similarity = 0.0; @Field var covered: [String] = []; @Field var offered = false; @Field var preview = DisclosureRecord() }
struct ProposalRecord: Record { @Field var requestId = ""; @Field var agentId = ""; @Field var question = ""; @Field var candidates: [CandidateRecord] = []; @Field var auto = false }
struct OutcomeRecord: Record { @Field var kind = "denied"; @Field var disclosures: [DisclosureRecord]? = nil; @Field var auto: Bool? = nil; @Field var at = 0.0 }
struct BridgeRequestRecord: Record { @Field var id = ""; @Field var agentId = ""; @Field var question = ""; @Field var receivedAt = 0.0; @Field var status = OutcomeRecord() }

private final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {}
