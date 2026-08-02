import SwiftUI
import UIKit

/// Central status → color/icon mapping, shared between the SwiftUI phone
/// companion view (needs `Color`) and the CarPlay templates (need `UIColor`
/// / tinted `UIImage`s — CPListItem has no notion of SwiftUI `Color`).
enum StatusPalette {
    static func uiColor(for level: AlertLevel) -> UIColor {
        switch level {
        case .critical: return UIColor(red: 1.00, green: 0.231, blue: 0.188, alpha: 1) // #FF3B30
        case .warning: return UIColor(red: 1.00, green: 0.584, blue: 0.000, alpha: 1) // #FF9500
        case .info: return UIColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1) // #34C759
        }
    }

    static func color(for level: AlertLevel) -> Color {
        Color(uiColor(for: level))
    }

    static func sfSymbol(for level: AlertLevel) -> String {
        switch level {
        case .critical: return "exclamationmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info: return "info.circle.fill"
        }
    }

    static func uiColor(for status: ServiceState) -> UIColor {
        switch status {
        case .up: return UIColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1) // #34C759
        case .down: return UIColor(red: 1.00, green: 0.231, blue: 0.188, alpha: 1) // #FF3B30
        case .maintenance: return UIColor(red: 1.00, green: 0.584, blue: 0.000, alpha: 1) // #FF9500
        case .paused: return UIColor(red: 0.557, green: 0.557, blue: 0.576, alpha: 1) // #8E8E93
        }
    }

    static func color(for status: ServiceState) -> Color {
        Color(uiColor(for: status))
    }

    static func sfSymbol(for status: ServiceState) -> String {
        switch status {
        case .up: return "checkmark.circle.fill"
        case .down: return "xmark.circle.fill"
        case .maintenance: return "wrench.and.screwdriver.fill"
        case .paused: return "pause.circle.fill"
        }
    }

    /// Green < 50%, yellow 50-75%, orange 75-90%, red > 90% — used for
    /// CPU/RAM/Disk/Temperature gauges in both the metrics column and the
    /// phone companion view.
    static func uiColor(forPercentage value: Double) -> UIColor {
        switch value {
        case ..<50: return UIColor(red: 0.204, green: 0.780, blue: 0.349, alpha: 1) // green
        case 50..<75: return UIColor(red: 1.00, green: 0.80, blue: 0.00, alpha: 1) // yellow
        case 75..<90: return UIColor(red: 1.00, green: 0.584, blue: 0.000, alpha: 1) // orange
        default: return UIColor(red: 1.00, green: 0.231, blue: 0.188, alpha: 1) // red
        }
    }

    static func color(forPercentage value: Double) -> Color {
        Color(uiColor(forPercentage: value))
    }

    /// Renders an SF Symbol as a flat, tinted UIImage for use in a
    /// CPListItem, which takes a plain `UIImage` rather than a SwiftUI
    /// `Image`/color pair.
    static func tintedImage(systemName: String, tint: UIColor, pointSize: CGFloat = 24) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
        return UIImage(systemName: systemName, withConfiguration: config)?
            .withTintColor(tint, renderingMode: .alwaysOriginal)
    }
}
