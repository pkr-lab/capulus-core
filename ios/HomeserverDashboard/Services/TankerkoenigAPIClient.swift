import Foundation

enum TankerkoenigError: LocalizedError {
    case missingAPIKey
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "Kein Tankerkönig-API-Key hinterlegt — in den Einstellungen ergänzen."
        case .requestFailed(let message):
            return message
        }
    }
}

/// Talks to the Tankerkönig API directly from the app — same public API
/// Glance's "Tankpreise" widget uses (see argocd/apps/glance/templates/
/// configmap.yaml), just with its own API key in this device's Keychain
/// instead of the cluster's sealed secret.
final class TankerkoenigAPIClient {
    private let session = URLSession(configuration: .default)
    private let decoder = JSONDecoder()

    func getPrices(stationIDs: [String]) async throws -> [String: TankerkoenigPricesResponse.StationPrices] {
        var components = URLComponents(url: Constants.Tankerkoenig.baseURL.appendingPathComponent("prices.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "ids", value: stationIDs.joined(separator: ",")),
            URLQueryItem(name: "apikey", value: try apiKey()),
        ]

        let response: TankerkoenigPricesResponse = try await get(components)
        guard response.ok, let prices = response.prices else {
            throw TankerkoenigError.requestFailed(response.message ?? "Tankpreise konnten nicht geladen werden.")
        }
        return prices
    }

    func getNearbyStations(latitude: Double, longitude: Double, radiusKm: Int) async throws -> [TankerkoenigListResponse.NearbyStation] {
        var components = URLComponents(url: Constants.Tankerkoenig.baseURL.appendingPathComponent("list.php"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "lat", value: String(latitude)),
            URLQueryItem(name: "lng", value: String(longitude)),
            URLQueryItem(name: "rad", value: String(radiusKm)),
            URLQueryItem(name: "sort", value: "dist"),
            URLQueryItem(name: "type", value: "all"),
            URLQueryItem(name: "apikey", value: try apiKey()),
        ]

        let response: TankerkoenigListResponse = try await get(components)
        guard response.ok, let stations = response.stations else {
            throw TankerkoenigError.requestFailed(response.message ?? "Tankstellen in der Nähe konnten nicht geladen werden.")
        }
        return stations
    }

    private func apiKey() throws -> String {
        guard let key = try? KeychainService.shared.getTankerkoenigAPIKey(), !key.isEmpty else {
            throw TankerkoenigError.missingAPIKey
        }
        return key
    }

    private func get<T: Decodable>(_ components: URLComponents) async throws -> T {
        let (data, response) = try await session.data(from: components.url!)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw TankerkoenigError.requestFailed("Tankerkönig antwortete mit HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1).")
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw TankerkoenigError.requestFailed("Antwort von Tankerkönig konnte nicht gelesen werden.")
        }
    }
}
