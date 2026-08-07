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

    private let client = WeatherAPIClient()

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
                            TodayWeatherCard(day: daily.day(at: 0))
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
        do {
            forecast = try await client.getForecast()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}

/// Groß, icon-geführt, mit einer kleinen Kennzahlen-Reihe (Regen, Wind) —
/// das ist die Karte, die man auf einen Blick lesen soll.
private struct TodayWeatherCard: View {
    let day: DayForecast?

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
                            Text("\(Int(day.minTemp.rounded()))° / \(Int(day.maxTemp.rounded()))°")
                                .font(.system(size: 36, weight: .bold, design: .rounded))
                                .foregroundStyle(Theme.textPrimary)
                        }

                        Spacer()
                    }

                    HStack(spacing: 12) {
                        WeatherStatChip(systemImage: "cloud.rain.fill", label: "Regen", value: "\(day.precipitationProbability)%")
                        WeatherStatChip(systemImage: "wind", label: "Wind", value: "\(Int(day.windSpeed.rounded())) km/h")
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
