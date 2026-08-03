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
}
