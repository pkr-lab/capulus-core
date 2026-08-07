import Foundation

enum WeatherError: LocalizedError {
    case requestFailed

    var errorDescription: String? {
        "Wetter konnte nicht geladen werden."
    }
}

/// Talks to Open-Meteo directly — no API key needed, same endpoint/params
/// as Glance's "Wetter — Morgen" widget (see argocd/apps/glance/templates/
/// configmap.yaml).
final class WeatherAPIClient {
    private let session = URLSession(configuration: .default)
    private let decoder = JSONDecoder()

    func getForecast() async throws -> WeatherForecast {
        var components = URLComponents(url: Constants.Weather.openMeteoForecastURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "latitude", value: Constants.Weather.latitude),
            URLQueryItem(name: "longitude", value: Constants.Weather.longitude),
            URLQueryItem(name: "current", value: "temperature_2m"),
            URLQueryItem(name: "daily", value: "temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max,windspeed_10m_max,sunrise,sunset"),
            URLQueryItem(name: "timezone", value: "Europe/Berlin"),
            URLQueryItem(name: "forecast_days", value: "2"),
        ]

        let (data, response) = try await session.data(from: components.url!)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw WeatherError.requestFailed
        }
        return try decoder.decode(WeatherForecast.self, from: data)
    }
}
