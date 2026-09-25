import Foundation

enum PegelError: LocalizedError {
    case requestFailed

    var errorDescription: String? {
        "Pegelstand konnte nicht geladen werden."
    }
}

final class PegelAPIClient {
    private let session = URLSession(configuration: .default)
    private let decoder = JSONDecoder()

    func getCurrentMeasurement() async throws -> PegelMeasurement {
        let url = Constants.Pegel.baseURL
            .appendingPathComponent("stations")
            .appendingPathComponent(Constants.Pegel.stationUUID)
            .appendingPathComponent("W")
            .appendingPathComponent("currentmeasurement.json")

        let (data, response) = try await session.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw PegelError.requestFailed
        }
        return try decoder.decode(PegelMeasurement.self, from: data)
    }
}
