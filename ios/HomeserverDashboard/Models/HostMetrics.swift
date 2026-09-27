import Foundation

struct HostMetrics: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let online: Bool
    let cpu: Double
    let ram: Double
    let disk: Double
    let temperature: Double
    let uptime: String
}
