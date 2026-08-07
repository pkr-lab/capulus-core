import Foundation

/// Decodes the Pegelonline (WSV) `currentmeasurement.json` response for one
/// station — see PegelAPIClient.
struct PegelMeasurement: Decodable {
    let value: Double
    let stateMnwMhw: String?

    /// Rough German label for `stateMnwMhw` ("low"/"normal"/"high" relative
    /// to mean low/high water) — Pegelonline doesn't document more values
    /// than these three, so anything else falls back to the raw code
    /// rather than guessing a translation.
    var stateLabel: String {
        switch stateMnwMhw {
        case "low": return "Niedrig"
        case "normal": return "Normal"
        case "high": return "Hoch"
        default: return stateMnwMhw ?? "—"
        }
    }
}
