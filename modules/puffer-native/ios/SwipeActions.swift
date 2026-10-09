import ExpoModulesCore
import ExpoUI
import SwiftUI

/// Registers Puffer's own @expo/ui modifiers. @expo/ui 55 has no swipe actions.
public class PufferUIModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PufferUI")

    OnCreate {
      ViewModifierRegistry.register("swipeActions") { params, appContext, eventDispatcher in
        try SwipeActionsModifier(from: params, appContext: appContext, eventDispatcher: eventDispatcher)
      }
    }

    OnDestroy {
      ViewModifierRegistry.unregister("swipeActions")
    }
  }
}

/// The tints JS may name. An unknown name falls back to the system tint rather than dropping the modifier.
enum SwipeTint: String {
  case red, orange, indigo, purple, gray, blue, yellow, green

  var color: Color {
    switch self {
    case .red: .red
    case .orange: .orange
    case .indigo: .indigo
    case .purple: .purple
    case .gray: .gray
    case .blue: .blue
    case .yellow: .yellow
    case .green: .green
    }
  }
}

struct SwipeButton: Record {
  @Field var id: String = ""
  @Field var label: String = ""
  @Field var systemImage: String?
  @Field var tint: String?
  @Field var destructive: Bool?
}

/// `$type: "swipeActions"`. A tap sends `{ swipeActions: { id } }` to the modifier's event listener.
struct SwipeActionsModifier: ViewModifier, Record {
  @Field var leading: [SwipeButton] = []
  @Field var trailing: [SwipeButton] = []
  @Field var leadingFullSwipe: Bool = true
  @Field var trailingFullSwipe: Bool = true

  var eventDispatcher: EventDispatcher?

  init() {}

  init(from params: Dict, appContext: AppContext, eventDispatcher: EventDispatcher) throws {
    try self = .init(from: params, appContext: appContext)
    self.eventDispatcher = eventDispatcher
  }

  /// `Self.Content`: LiteRTLM in this pod declares its own `Content`.
  func body(content: Self.Content) -> some View {
    content
      .swipeButtons(leading, edge: .leading, allowsFullSwipe: leadingFullSwipe, dispatch: dispatch)
      .swipeButtons(trailing, edge: .trailing, allowsFullSwipe: trailingFullSwipe, dispatch: dispatch)
  }

  private func dispatch(_ id: String) {
    eventDispatcher?(["swipeActions": ["id": id]])
  }
}

private extension View {
  @ViewBuilder
  func swipeButtons(_ list: [SwipeButton], edge: HorizontalEdge, allowsFullSwipe: Bool, dispatch: @escaping (String) -> Void) -> some View {
    if list.isEmpty {
      self
    } else {
      swipeActions(edge: edge, allowsFullSwipe: allowsFullSwipe) {
        ForEach(list.indices, id: \.self) { index in
          let button = list[index]
          Button(role: button.destructive == true ? .destructive : nil) {
            dispatch(button.id)
          } label: {
            if let systemImage = button.systemImage {
              Label(button.label, systemImage: systemImage)
            } else {
              Text(button.label)
            }
          }
          .tint(button.tint.flatMap(SwipeTint.init(rawValue:))?.color)
        }
      }
    }
  }
}
