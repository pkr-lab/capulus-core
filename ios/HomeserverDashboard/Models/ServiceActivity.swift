import Foundation

/// One self-hosted app's current Traefik request rate. Mirrors
/// `models.ServiceActivity` in carplay-api — an activity proxy, NOT a
/// distinct-user count (Traefik has no notion of identity, see
/// carplay-api's clients.VictoriaMetricsClient.GetServiceActivity).
struct ServiceActivity: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let requestsPerSecond: Double

    enum CodingKeys: String, CodingKey {
        case id, name
        case requestsPerSecond = "requests_per_second"
    }
}
