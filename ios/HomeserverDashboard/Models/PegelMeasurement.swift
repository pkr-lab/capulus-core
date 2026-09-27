import Foundation

struct PegelMeasurement: Decodable {
    let value: Double
    let stateMnwMhw: String?

    var stateLabel: String {
        switch stateMnwMhw {
        case "low": return "Niedrig"
        case "normal": return "Normal"
        case "high": return "Hoch"
        default: return stateMnwMhw ?? "—"
        }
    }
}
