import Foundation

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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try container.decodeIfPresent([Alert].self, forKey: .alerts) ?? []
        hosts = try container.decodeIfPresent([HostMetrics].self, forKey: .hosts) ?? []
        status = try container.decode([ServiceStatus].self, forKey: .status)
        serviceActivity = try container.decodeIfPresent([ServiceActivity].self, forKey: .serviceActivity) ?? []
        updatedAt = try container.decode(Int64.self, forKey: .updatedAt)
    }
}
