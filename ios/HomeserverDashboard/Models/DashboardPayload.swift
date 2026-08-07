import Foundation

/// Full payload from `GET /api/dashboard`. Mirrors `models.DashboardResponse`
/// in carplay-api.
struct DashboardPayload: Codable, Equatable {
    let alerts: [Alert]
    let hosts: [HostMetrics]
    let status: [ServiceStatus]
    let serviceActivity: [ServiceActivity]
    let updatedAt: Int64

    enum CodingKeys: String, CodingKey {
        case alerts, hosts, status
        case serviceActivity = "service_activity"
        case updatedAt = "updated_at"
    }

    // carplay-api serializes an empty/nil alerts/hosts slice as JSON `null`
    // (Go's zero value for a slice), not `[]` — decodeIfPresent treats an
    // explicit null the same as a missing key, so this falls back to []
    // instead of JSONDecoder throwing and failing the whole response.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try container.decodeIfPresent([Alert].self, forKey: .alerts) ?? []
        hosts = try container.decodeIfPresent([HostMetrics].self, forKey: .hosts) ?? []
        status = try container.decode([ServiceStatus].self, forKey: .status)
        serviceActivity = try container.decodeIfPresent([ServiceActivity].self, forKey: .serviceActivity) ?? []
        updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
    }
}
