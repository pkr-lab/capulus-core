import Foundation

/// One monitored machine's snapshot (VictoriaMetrics). Mirrors
/// `models.HostMetrics` in carplay-api. `online` reflects the "up" scrape
/// result for that host — false means every numeric field is a zero-value
/// placeholder, not a real reading, which is why the home screen hides
/// offline hosts instead of showing them at 0%.
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
