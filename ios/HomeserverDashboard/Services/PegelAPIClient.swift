import Foundation

enum PegelError: LocalizedError {
    case requestFailed

    var errorDescription: String? {
        "Pegelstand konnte nicht geladen werden."
    }
}

/// Talks to Pegelonline (WSV) directly — public REST API, no key needed,
/// same data source as the "Rhein-Pegel Andernach"-Idee in
/// IdeasToDeploy.md. Station UUID is fixed (Andernach), see
/// Constants.Pegel.
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
