import Foundation

/// One ntfy notification. Mirrors `models.Alert` in carplay-api
/// (argocd/apps/carplay-api/src/internal/models/types.go) — field names and
/// JSON keys must stay in lockstep with the backend.
struct Alert: Codable, Identifiable, Equatable {
    let id: String
    let topic: String
    let title: String
    let message: String
    let time: Int64
    let level: AlertLevel
    let pollId: String?

    enum CodingKeys: String, CodingKey {
        case id, topic, title, message, time, level
        case pollId = "poll_id"
    }
}

enum AlertLevel: String, Codable {
    case critical
    case warning
    case info

    /// Unknown levels degrade to `.info` instead of failing to decode the
    /// whole dashboard over one unexpected value from the backend.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AlertLevel(rawValue: raw) ?? .info
    }
}
