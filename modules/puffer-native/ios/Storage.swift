import Foundation
import SQLite3

/// A thin SQLite connection. One instance per database, owned by exactly one actor.
final class SQLiteDB {
  private var db: OpaquePointer?
  static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(url: URL, schema: String) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      throw PufferError.storeFailed(message)
    }
    try exec("PRAGMA journal_mode = WAL;\n\(schema)")
  }

  deinit { sqlite3_close_v2(db) }

  var message: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open" }

  /// Rows the last INSERT, UPDATE or DELETE changed.
  var changes: Int { Int(sqlite3_changes(db)) }

  var lastInsertRowID: Int64 { sqlite3_last_insert_rowid(db) }

  func exec(_ sql: String) throws {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw PufferError.storeFailed(message) }
  }

  func transaction(_ body: () throws -> Void) throws {
    try exec("BEGIN IMMEDIATE")
    do {
      try body()
      try exec("COMMIT")
    } catch {
      try? exec("ROLLBACK")
      throw error
    }
  }

  /// Runs `sql` with `bindings`, calling `row` for each result row.
  func query(_ sql: String, _ bindings: [Binding] = [], row: (Row) throws -> Void = { _ in }) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw PufferError.storeFailed(message) }
    defer { sqlite3_finalize(statement) }
    for (offset, binding) in bindings.enumerated() {
      let index = Int32(offset + 1)
      switch binding {
      case let .text(value?): sqlite3_bind_text(statement, index, value, -1, Self.transient)
      case .text(nil): sqlite3_bind_null(statement, index)
      case let .int(value): sqlite3_bind_int64(statement, index, value)
      case let .real(value): sqlite3_bind_double(statement, index, value)
      case let .blob(data): data.withUnsafeBytes { _ = sqlite3_bind_blob(statement, index, $0.baseAddress, Int32($0.count), Self.transient) }
      }
    }
    while true {
      switch sqlite3_step(statement) {
      case SQLITE_ROW: try row(Row(statement: statement))
      case SQLITE_DONE: return
      default: throw PufferError.storeFailed(message)
      }
    }
  }

  enum Binding {
    case text(String?)
    case int(Int64)
    case real(Double)
    case blob(Data)
  }

  struct Row {
    let statement: OpaquePointer?
    func text(_ column: Int32) -> String? { sqlite3_column_text(statement, column).map { String(cString: $0) } }
    func int(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
    func double(_ column: Int32) -> Double { sqlite3_column_double(statement, column) }
    func blob(_ column: Int32) -> UnsafeRawBufferPointer {
      UnsafeRawBufferPointer(start: sqlite3_column_blob(statement, column), count: Int(sqlite3_column_bytes(statement, column)))
    }
  }
}

/// JSON documents by id, one table per kind. Bridge state is small and read whole at start.
struct DocumentTable {
  let db: SQLiteDB
  let name: String

  static func schema(_ name: String) -> String {
    "CREATE TABLE IF NOT EXISTS \(name) (id TEXT PRIMARY KEY NOT NULL, position REAL NOT NULL, json TEXT NOT NULL);"
  }

  /// A row this build cannot decode is logged and stays in the table untouched. `salvage` may still make a value of it
  /// from its id and raw JSON.
  func all<T: Decodable>(_ type: T.Type, salvage: (_ id: String, _ json: String) -> T? = { _, _ in nil }) throws -> [T] {
    var out: [T] = []
    let table = name
    try db.query("SELECT id, json FROM \(name) ORDER BY position, rowid") { row in
      let id = row.text(0) ?? ""
      let json = row.text(1) ?? ""
      do {
        out.append(try Self.decoder.decode(T.self, from: Data(json.utf8)))
      } catch {
        let salvaged = salvage(id, json)
        pufferLog.error("\(table, privacy: .public) row \(id, privacy: .public) unreadable\(salvaged == nil ? "" : ", salvaged", privacy: .public): \(error.localizedDescription, privacy: .public)")
        if let salvaged { out.append(salvaged) }
      }
    }
    return out
  }

  func get<T: Decodable>(_ type: T.Type, id: String) throws -> T? {
    var json: String?
    try db.query("SELECT json FROM \(name) WHERE id = ?", [.text(id)]) { json = $0.text(0) }
    return try json.map { try Self.decoder.decode(T.self, from: Data($0.utf8)) }
  }

  func delete(before position: Double) throws {
    try db.query("DELETE FROM \(name) WHERE position < ?", [.real(position)])
  }

  func put<T: Encodable>(_ id: String, _ value: T, position: Double) throws {
    let json = String(decoding: try Self.encoder.encode(value), as: UTF8.self)
    try db.query("INSERT INTO \(name) (id, position, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
                 [.text(id), .real(position), .text(json)])
  }

  func delete(_ id: String) throws {
    try db.query("DELETE FROM \(name) WHERE id = ?", [.text(id)])
  }

  static let encoder = JSONEncoder()
  static let decoder = JSONDecoder()
}
