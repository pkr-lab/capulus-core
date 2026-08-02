import Foundation

enum FormatterHelper {
    /// Truncates to `maxLength`, appending "…" if anything was cut — used
    /// to keep CarPlay list rows from wrapping/clipping mid-word.
    static func truncate(_ text: String, maxLength: Int) -> String {
        guard text.count > maxLength else { return text }
        let cutIndex = text.index(text.startIndex, offsetBy: max(0, maxLength - 1))
        return String(text[..<cutIndex]) + "…"
    }

    static func percentage(_ value: Double) -> String {
        String(format: "%.0f%%", value)
    }

    static func celsius(_ value: Double) -> String {
        String(format: "%.0f°C", value)
    }

    static func ping(_ ms: Int) -> String {
        "\(ms)ms"
    }

    static func uptimePercentage(_ value: Double) -> String {
        String(format: "%.2f%%", value)
    }

    static func relativeTime(_ unixSeconds: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(unixSeconds))
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
