import Foundation

struct ServiceActivity: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let requestsPerSecond: Double

    enum CodingKeys: String, CodingKey {
        case id, name
        case requestsPerSecond = "requests_per_second"
    }
}
