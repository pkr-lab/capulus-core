import Foundation

struct BrightnessResponse: Codable {
    let percent: Int
}

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
