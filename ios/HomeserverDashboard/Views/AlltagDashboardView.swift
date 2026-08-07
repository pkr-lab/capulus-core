import SwiftUI

/// Alltag-Modus-Variante des Dashboards: statt Server-Metriken (siehe
/// HomeView) zeigt sie Wetter heute + morgen, analog zu Glances
/// "Wetter — Heute"/"Wetter — Morgen"-Widgets (siehe argocd/apps/glance/
/// templates/configmap.yaml), nur nativ statt per HTML-Widget-Template.
/// "Heute" bekommt die anschaulichere, größere Karte — "Morgen" bleibt
/// kompakt als reiner Ausblick.
struct AlltagDashboardView: View {
    @State private var forecast: WeatherForecast?
    @State private var isLoading = false
    @State private var error: String?

    @State private var pegel: PegelMeasurement?
    @State private var pegelError: String?

    private let client = WeatherAPIClient()
    private let pegelClient = PegelAPIClient()

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(spacing: 16) {
                        if isLoading && forecast == nil {
                            ProgressView()
                                .tint(Theme.textPrimary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 40)
                        } else if let daily = forecast?.daily {
                            TodayWeatherCard(day: daily.day(at: 0), currentTemp: forecast?.current?.temperature2m)
                            TomorrowWeatherCard(day: daily.day(at: 1))

                            HStack(spacing: 6) {
                                Image(systemName: "location.fill")
                                Text(Constants.Weather.locationLabel)
                            }
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textMuted)
                        }

                        if let error {
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.statusBad)
                        }

                        PegelCard(measurement: pegel, error: pegelError, isLoading: isLoading && pegel == nil)

                        ServicesCard()
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Dashboard")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        error = nil
        pegelError = nil
        async let weatherResult: Void = loadWeather()
        async let pegelResult: Void = loadPegel()
        _ = await (weatherResult, pegelResult)
        isLoading = false
    }

    private func loadWeather() async {
        do {
            forecast = try await client.getForecast()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadPegel() async {
        do {
            pegel = try await pegelClient.getCurrentMeasurement()
        } catch {
            pegelError = error.localizedDescription
        }
    }
}

/// Groß, icon-geführt, mit einer kleinen Kennzahlen-Reihe (Regen, Wind) —
/// das ist die Karte, die man auf einen Blick lesen soll.
private struct TodayWeatherCard: View {
    let day: DayForecast?
    let currentTemp: Double?

    var body: some View {
        SectionCard(title: "Wetter — Heute", systemImage: "sun.max.fill") {
            if let day {
                VStack(spacing: 16) {
                    HStack(spacing: 16) {
                        Image(systemName: day.symbolName)
                            .symbolRenderingMode(.multicolor)
                            .font(.system(size: 46))
                            .frame(width: 56)

                        VStack(alignment: .leading, spacing: 4) {
                            Text(day.condition)
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(Theme.textPrimary)
                            if let currentTemp {
                                Text("\(Int(currentTemp.rounded()))°")
                                    .font(.system(size: 36, weight: .bold, design: .rounded))
                                    .foregroundStyle(Theme.textPrimary)
                            }
                            Text("\(Int(day.minTemp.rounded()))° / \(Int(day.maxTemp.rounded()))°")
                                .font(.system(size: currentTemp == nil ? 36 : 15, weight: currentTemp == nil ? .bold : .medium, design: .rounded))
                                .foregroundStyle(currentTemp == nil ? Theme.textPrimary : Theme.textMuted)
                        }

                        Spacer()
                    }

                    HStack(spacing: 12) {
                        WeatherStatChip(systemImage: "cloud.rain.fill", label: "Regen", value: "\(day.precipitationProbability)%")
                        WeatherStatChip(systemImage: "wind", label: "Wind", value: "\(Int(day.windSpeed.rounded())) km/h")
                    }

                    if let sunrise = day.sunriseDate, let sunset = day.sunsetDate {
                        SunPathView(sunrise: sunrise, sunset: sunset)
                    }
                }
            } else {
                Text("Keine Daten")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// Sonnenverlauf als Bogen (Bezier-Kurve statt echter Ellipse — reicht für
/// den visuellen Eindruck und macht die Positionsberechnung fürs
/// Sonne/Mond-Symbol trivial, weil dieselbe quadratische Formel zum Zeichnen
/// und zum Platzieren verwendet wird). Tagsüber wandert eine Sonne entlang
/// des Bogens, außerhalb der Tageszeit steht ein Mond am jeweiligen Ende.
private struct SunPathView: View {
    let sunrise: Date
    let sunset: Date

    /// `nil` outside of daylight hours (before sunrise / after sunset).
    private var dayProgress: Double? {
        guard sunset > sunrise else { return nil }
        let now = Date()
        guard now >= sunrise, now <= sunset else { return nil }
        return now.timeIntervalSince(sunrise) / sunset.timeIntervalSince(sunrise)
    }

    var body: some View {
        VStack(spacing: 10) {
            GeometryReader { geo in
                let inset: CGFloat = 16
                let p0 = CGPoint(x: inset, y: geo.size.height)
                let p2 = CGPoint(x: geo.size.width - inset, y: geo.size.height)
                let p1 = CGPoint(x: geo.size.width / 2, y: 0)
                let t = dayProgress ?? (Date() < sunrise ? 0 : 1)
                let markerPoint = Self.quadraticPoint(p0, p1, p2, CGFloat(t))

                ZStack {
                    Path { path in
                        path.move(to: CGPoint(x: 0, y: geo.size.height))
                        path.addLine(to: CGPoint(x: geo.size.width, y: geo.size.height))
                    }
                    .stroke(Theme.textMuted.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))

                    Path { path in
                        path.move(to: p0)
                        path.addQuadCurve(to: p2, control: p1)
                    }
                    .stroke(Theme.accentLight.opacity(0.55), style: StrokeStyle(lineWidth: 2, lineCap: .round))

                    Image(systemName: dayProgress != nil ? "sun.max.fill" : "moon.stars.fill")
                        .symbolRenderingMode(.multicolor)
                        .font(.system(size: 20))
                        .position(markerPoint)
                }
            }
            .frame(height: 60)

            HStack {
                Label(Self.timeFormatter.string(from: sunrise), systemImage: "sunrise.fill")
                Spacer()
                Label(Self.timeFormatter.string(from: sunset), systemImage: "sunset.fill")
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.textMuted)
        }
    }

    private static func quadraticPoint(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ t: CGFloat) -> CGPoint {
        let mt = 1 - t
        return CGPoint(
            x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
            y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
        )
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        formatter.timeZone = TimeZone(identifier: "Europe/Berlin")
        return formatter
    }()
}

private struct WeatherStatChip: View {
    let systemImage: String
    let label: String
    let value: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .foregroundStyle(Theme.accentLight)
            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}

/// Kompakter Ausblick — dieselben Werte wie heute, ohne den großen Icon-
/// Header, damit sich die Karte optisch klar der "Heute"-Karte unterordnet.
private struct TomorrowWeatherCard: View {
    let day: DayForecast?

    var body: some View {
        SectionCard(title: "Wetter — Morgen", systemImage: "cloud.sun.fill") {
            if let day {
                VStack(spacing: 10) {
                    Text(day.condition)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)

                    Text("\(Int(day.minTemp.rounded()))° / \(Int(day.maxTemp.rounded()))°")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.textPrimary)

                    Text("Regenwahrscheinlichkeit \(day.precipitationProbability)% · Wind bis \(Int(day.windSpeed.rounded())) km/h")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                }
                .frame(maxWidth: .infinity)
            } else {
                Text("Keine Daten")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

/// Aktueller Rhein-Pegel Andernach (Pegelonline/WSV, siehe
/// Constants.Pegel) — ergänzt die Wetterkarten um eine zweite,
/// alltagsrelevante Lage-Info direkt am Rhein.
private struct PegelCard: View {
    let measurement: PegelMeasurement?
    let error: String?
    let isLoading: Bool

    var body: some View {
        SectionCard(title: Constants.Pegel.stationLabel, systemImage: "drop.fill") {
            if let measurement {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(Int(measurement.value.rounded())) cm")
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.textPrimary)
                    Spacer()
                    Text(measurement.stateLabel)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
            } else if isLoading {
                ProgressView()
                    .tint(Theme.textMuted)
                    .frame(maxWidth: .infinity)
            } else {
                Text(error ?? "Keine Daten")
                    .font(.system(size: 13))
                    .foregroundStyle(error != nil ? Theme.statusBad : Theme.textMuted)
            }
        }
    }
}

/// Kurzlink-Kacheln zu den self-hosted Diensten (siehe
/// Constants.SelfHostedServices) — reine Link-Liste ohne eigenen Live-
/// Status, öffnet den jeweiligen Dienst in Safari über Tailscale.
private struct ServicesCard: View {
    @Environment(\.openURL) private var openURL

    private let columns = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        SectionCard(title: "Dienste", systemImage: "link") {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(Constants.SelfHostedServices.all) { service in
                    Button { openURL(service.url) } label: {
                        ServiceTile(service: service)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct ServiceTile: View {
    let service: SelfHostedService

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: service.systemImage)
                .font(.system(size: 20))
                .foregroundStyle(Theme.accentLight)
            Text(service.name)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}
