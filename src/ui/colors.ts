import { foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { PlatformColor } from 'react-native';

/** Behind every screen, so a SwiftUI host that remounts shows the grouped list color, never white. Dynamic for dark mode. */
export const screenBackground = { backgroundColor: PlatformColor('systemGroupedBackground') };

// Fixed system colors on purpose. A hierarchical style inside a Button resolves against the button's tint and turns
// blue, and named strings like 'blue' resolve to CSS colors (#0000FF), not the system palette.
export const secondary = foregroundStyle(PlatformColor('secondaryLabel'));
export const tertiary = foregroundStyle(PlatformColor('tertiaryLabel'));
export const blue = foregroundStyle(PlatformColor('systemBlue'));
export const orange = foregroundStyle(PlatformColor('systemOrange'));
export const green = foregroundStyle(PlatformColor('systemGreen'));
export const yellow = foregroundStyle(PlatformColor('systemYellow'));

/** Apple Notes' accent, for the Notes tab's buttons and marks. */
export const notesTint = PlatformColor('systemYellow');
/** For navigation options that take a color string. */
export const notesTintHex = '#E5A00D';
