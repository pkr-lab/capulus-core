import Foundation

/// One Uptime-Kuma monitor. Mirrors `models.ServiceStatus` in carplay-api.
struct ServiceStatus: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let status: ServiceState
    let ping: Int
    let uptime: Double
    let lastCheck: Int64

    enum CodingKeys: String, CodingKey {
        case id, name, status, ping, uptime
        case lastCheck = "last_check"
    }
}

enum ServiceState: String, Codable {
    case up
    case down
    case maintenance
    case paused

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ServiceState(rawValue: raw) ?? .down
    }
}
