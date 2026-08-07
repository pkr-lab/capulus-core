import SwiftUI

/// Tankstellen-Seite im Alltag-Modus: Preise der drei festen Glance-
/// Stationen (siehe argocd/apps/glance/templates/configmap.yaml) plus die
/// nächstgelegene Nicht-Shell/Aral-Station zum aktuellen Standort. Zeigt
/// nur Super (E5) und Super E10 — kein Diesel.
struct TankstellenView: View {
    @State private var fixedPrices: [String: TankerkoenigPricesResponse.StationPrices] = [:]
    @State private var nearestStation: TankerkoenigListResponse.NearbyStation?
    @State private var fixedError: String?
    @State private var nearbyError: String?
    @State private var isLoading = false

    private let client = TankerkoenigAPIClient()
    @ObservedObject private var locationManager = LocationManager.shared
    @State private var showingSettings = false

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(spacing: 16) {
                        SectionCard(title: "Tankstellen", systemImage: "fuelpump.fill") {
                            VStack(spacing: 10) {
                                ForEach(Constants.Tankerkoenig.fixedStations) { station in
                                    FixedStationRow(
                                        station: station,
                                        prices: fixedPrices[station.id],
                                        isLoading: isLoading
                                    )
                                }
                            }

                            if let fixedError {
                                Text(fixedError)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.statusBad)
                            }
                        }

                        SectionCard(title: "Nächste (ohne Shell/Aral)", systemImage: "location.fill") {
                            if let nearestStation {
                                NearbyStationRow(station: nearestStation)
                            } else if isLoading {
                                ProgressView()
                                    .tint(Theme.textPrimary)
                                    .frame(maxWidth: .infinity)
                            } else {
                                Text(nearbyError ?? "Keine Station in der Nähe gefunden.")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.textMuted)
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Tankstellen")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
        }
    }

    private func load() async {
        isLoading = true
        fixedError = nil
        nearbyError = nil
        async let fixed: Void = loadFixedPrices()
        async let nearby: Void = loadNearestStation()
        _ = await (fixed, nearby)
        isLoading = false
    }

    private func loadFixedPrices() async {
        do {
            fixedPrices = try await client.getPrices(stationIDs: Constants.Tankerkoenig.fixedStations.map(\.id))
        } catch {
            fixedError = error.localizedDescription
        }
    }

    private func loadNearestStation() async {
        do {
            let location = try await locationManager.requestLocation()
            let nearby = try await client.getNearbyStations(
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                radiusKm: Constants.Tankerkoenig.nearbySearchRadiusKm
            )
            // `sort=dist` already orders ascending by distance, so the
            // first station not on the excluded-brands list is the nearest
            // qualifying one.
            nearestStation = nearby.first { station in
                !Constants.Tankerkoenig.excludedBrands.contains { $0.caseInsensitiveCompare(station.brand) == .orderedSame }
            }
            if nearestStation == nil {
                nearbyError = "Keine passende Station im Umkreis von \(Constants.Tankerkoenig.nearbySearchRadiusKm) km gefunden."
            }
        } catch {
            nearbyError = error.localizedDescription
        }
    }
}

private struct FixedStationRow: View {
    let station: FuelStation
    let prices: TankerkoenigPricesResponse.StationPrices?
    let isLoading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(station.name) — \(station.address)")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)

            if let prices, prices.status == "open" {
                HStack(spacing: 20) {
                    PriceLabel(label: "Super", value: prices.e5)
                    PriceLabel(label: "Super E10", value: prices.e10)
                }
            } else if prices != nil {
                Text("Geschlossen")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.statusBad)
            } else if isLoading {
                ProgressView().tint(Theme.textMuted)
            } else {
                Text("Keine Daten")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}

private struct NearbyStationRow: View {
    let station: TankerkoenigListResponse.NearbyStation

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(station.name)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)

            Text("\(station.street) \(station.houseNumber ?? ""), \(station.place) · \(String(format: "%.1f km", station.dist))")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)

            if station.isOpen {
                HStack(spacing: 20) {
                    PriceLabel(label: "Super", value: station.e5)
                    PriceLabel(label: "Super E10", value: station.e10)
                }
            } else {
                Text("Geschlossen")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.statusBad)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}

private struct PriceLabel: View {
    let label: String
    let value: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
            Text(value.map { String(format: "%.3f €", $0) } ?? "—")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
        }
    }
}
