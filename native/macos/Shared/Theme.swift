import AppKit
import SwiftUI

extension Color {
    /// A color that follows the widget's light or dark appearance.
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(rgb: isDark ? dark : light)
        })
    }
}

private extension NSColor {
    convenience init(rgb: UInt32) {
        self.init(
            srgbRed: CGFloat((rgb >> 16) & 0xff) / 255,
            green: CGFloat((rgb >> 8) & 0xff) / 255,
            blue: CGFloat(rgb & 0xff) / 255,
            alpha: 1
        )
    }
}

extension Tone {
    /// The same tone colors as the Dashboard cards.
    var color: Color {
        switch self {
        case .good: Palette.good
        case .warning: Palette.warning
        case .danger: Palette.danger
        case .active: Palette.info
        case .neutral: Palette.muted
        }
    }
}

extension MetricTone {
    var color: Color {
        switch self {
        case .normal: Palette.accent
        case .warning: Palette.warning
        case .danger: Palette.danger
        }
    }
}
