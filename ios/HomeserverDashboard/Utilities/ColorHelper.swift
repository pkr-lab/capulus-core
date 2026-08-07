import SwiftUI

/// Central status → color/icon mapping used across Home/Brightness/Power.
enum StatusPalette {
    static func color(for level: AlertLevel) -> Color {
        switch level {
        case .critical: return Theme.statusBad
        case .warning: return Theme.statusWarning
        case .info: return Theme.statusGood
        }
    }

    static func sfSymbol(for level: AlertLevel) -> String {
        switch level {
        case .critical: return "exclamationmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info: return "info.circle.fill"
        }
    }

    static func color(for status: ServiceState) -> Color {
        switch status {
        case .up: return Theme.statusGood
        case .down: return Theme.statusBad
        case .maintenance: return Theme.statusWarning
        case .paused: return Theme.textMuted
        }
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
    /// CPU/RAM/Disk/Temperature gauges on the home screen's host cards.
    static func color(forPercentage value: Double) -> Color {
        switch value {
        case ..<50: return Theme.statusGood
        case 50..<75: return Color(hex: 0xffcc00)
        case 75..<90: return Theme.statusWarning
        default: return Theme.statusBad
        }
    }
}
