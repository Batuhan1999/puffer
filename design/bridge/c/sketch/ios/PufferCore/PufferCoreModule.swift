import ExpoModulesCore

// JS surface of the native core. Mirrors sketch/js/puffer-core.ts. Thin: each function forwards to one actor.
// Events: a single `changed` event carrying the revision numbers; JS refetches snapshots (see js/bridge.ts).
public class PufferCoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PufferCore")
    Events("changed")
    // AsyncFunction("search") { (req: SearchRequestJS) -> SearchResultJS in ... }
    // AsyncFunction("addItem"), ("hasItem"), ("listItems"), ("clearIndex")
    // AsyncFunction("snapshot") -> BridgeSnapshot, ("saveCollection"), ("removeCollection"), ("hideInCollection")
    // AsyncFunction("pair"), ("createAgent"), ("revokeAgent"), ("allow"), ("approve"), ("deny")
    // AsyncFunction("setSpotlight")
    fatalError("not implemented")
  }
}
