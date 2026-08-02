import Foundation

/// Fleet-wide snapshot from VictoriaMetrics. Mirrors `models.SystemMetrics`
/// in carplay-api.
struct SystemMetrics: Codable, Equatable {
    let cpu: Double
    let ram: Double
    let disk: Double
    let temperature: Double
    let uptime: String
    let loadAvg: String

    enum CodingKeys: String, CodingKey {
        case cpu, ram, disk, temperature, uptime
        case loadAvg = "load_avg"
    }

    static let placeholder = SystemMetrics(
        cpu: 0, ram: 0, disk: 0, temperature: 0, uptime: "N/A", loadAvg: "N/A"
    )
}
