import Foundation

/// Full payload from `GET /api/dashboard`. Mirrors `models.DashboardResponse`
/// in carplay-api.
struct CarPlayDashboard: Codable, Equatable {
    let alerts: [Alert]
    let metrics: SystemMetrics
    let status: [ServiceStatus]
    let updatedAt: Int64

    enum CodingKeys: String, CodingKey {
        case alerts, metrics, status
        case updatedAt = "updated_at"
    }

    // carplay-api serializes an empty/nil alerts slice as JSON `null`
    // (Go's zero value for a slice), not `[]` — decodeIfPresent treats an
    // explicit null the same as a missing key, so this falls back to []
    // instead of JSONDecoder throwing and failing the whole response.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try container.decodeIfPresent([Alert].self, forKey: .alerts) ?? []
        metrics = try container.decode(SystemMetrics.self, forKey: .metrics)
        status = try container.decode([ServiceStatus].self, forKey: .status)
        updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
    }
}
