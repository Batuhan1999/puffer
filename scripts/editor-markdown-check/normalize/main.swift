import Foundation

// Reads a JSON array of Markdown strings on stdin and prints what the native editor saves for each, for tiptap.mjs.
let input = FileHandle.standardInput.readDataToEndOfFile()
let sources = try JSONDecoder().decode([String].self, from: input)
let output = try JSONEncoder().encode(sources.map { NoteDocument(markdown: $0).markdown })
FileHandle.standardOutput.write(output)
