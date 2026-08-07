import Foundation

/// Decodes Open-Meteo's `/v1/forecast` daily block — same fields Glance's
/// "Wetter — Morgen" widget queries (see argocd/apps/glance/templates/
/// configmap.yaml) plus max wind speed, requested once for both today
/// (index 0) and tomorrow (index 1) instead of Glance's two separate
/// widgets/requests.
struct WeatherForecast: Decodable {
    let current: Current?
    let daily: Daily

    struct Current: Decodable {
        let temperature2m: Double

        enum CodingKeys: String, CodingKey {
            case temperature2m = "temperature_2m"
        }
    }

    struct Daily: Decodable {
        let weathercode: [Int]
        let temperature2mMax: [Double]
        let temperature2mMin: [Double]
        let precipitationProbabilityMax: [Int]
        let windspeed10mMax: [Double]
        let sunrise: [String]
        let sunset: [String]

        enum CodingKeys: String, CodingKey {
            case weathercode
            case temperature2mMax = "temperature_2m_max"
            case temperature2mMin = "temperature_2m_min"
            case precipitationProbabilityMax = "precipitation_probability_max"
            case windspeed10mMax = "windspeed_10m_max"
            case sunrise, sunset
        }

        func day(at index: Int) -> DayForecast? {
            guard weathercode.indices.contains(index),
                  temperature2mMin.indices.contains(index),
                  temperature2mMax.indices.contains(index),
                  precipitationProbabilityMax.indices.contains(index),
                  windspeed10mMax.indices.contains(index),
                  sunrise.indices.contains(index),
                  sunset.indices.contains(index)
            else { return nil }

            return DayForecast(
                code: weathercode[index],
                minTemp: temperature2mMin[index],
                maxTemp: temperature2mMax[index],
                precipitationProbability: precipitationProbabilityMax[index],
                windSpeed: windspeed10mMax[index],
                sunrise: sunrise[index],
                sunset: sunset[index]
            )
        }
    }
}

struct DayForecast {
    let code: Int
    let minTemp: Double
    let maxTemp: Double
    let precipitationProbability: Int
    let windSpeed: Double
    /// Open-Meteo's local (no offset) "yyyy-MM-dd'T'HH:mm", already in
    /// Europe/Berlin since that's the requested `timezone`.
    let sunrise: String
    let sunset: String

    var condition: String { WeatherCode.condition(for: code) }
    var symbolName: String { WeatherCode.symbolName(for: code) }
    var sunriseDate: Date? { Self.isoLocalFormatter.date(from: sunrise) }
    var sunsetDate: Date? { Self.isoLocalFormatter.date(from: sunset) }

    private static let isoLocalFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
        formatter.timeZone = TimeZone(identifier: "Europe/Berlin")
        return formatter
    }()
}

enum WeatherCode {
    /// Same weathercode → German label mapping as Glance's
    /// weatherTomorrowTemplate (argocd/apps/glance/templates/_helpers.tpl).
    static func condition(for code: Int) -> String {
        switch code {
        case 0: return "Klar"
        case 1, 2, 3: return "Bewölkt"
        case 45, 48: return "Nebel"
        case 51, 53, 55: return "Nieselregen"
        case 61, 63, 65: return "Regen"
        case 71, 73, 75: return "Schnee"
        case 80, 81, 82: return "Regenschauer"
        case 95, 96, 99: return "Gewitter"
        default: return "Wechselhaft"
        }
    }

    /// SF Symbol matching the same grouping as `condition(for:)`, for the
    /// more visual "Heute"-Karte.
    static func symbolName(for code: Int) -> String {
        switch code {
        case 0: return "sun.max.fill"
        case 1, 2, 3: return "cloud.sun.fill"
        case 45, 48: return "cloud.fog.fill"
        case 51, 53, 55: return "cloud.drizzle.fill"
        case 61, 63, 65: return "cloud.rain.fill"
        case 71, 73, 75: return "cloud.snow.fill"
        case 80, 81, 82: return "cloud.heavyrain.fill"
        case 95, 96, 99: return "cloud.bolt.rain.fill"
        default: return "cloud.fill"
        }
    }
}
