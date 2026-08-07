import Foundation

/// Mirrors carplay-api's `models.BrightnessResponse`.
struct BrightnessResponse: Codable {
    let percent: Int
}

/// Mirrors carplay-api's `models.PowerTarget`. worker0/worker1 rawValues
/// use hyphens to match the Go string constants exactly, since this is
/// sent verbatim as JSON.
enum PowerTarget: String, Codable, CaseIterable, Identifiable {
    case homeserver
    case worker0 = "worker-0"
    case worker1 = "worker-1"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .homeserver: return "Homeserver"
        case .worker0: return "Worker 0"
        case .worker1: return "Worker 1"
        }
    }
}
