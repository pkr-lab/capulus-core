import SwiftUI

/// The app's start screen: a short, visual overview of the fleet's
/// metrics — Homeserver, NAS, worker-0, worker-1, whichever of those are
/// currently on — plus service status. Alerts live in their own tab, see
/// AlertsView.swift.
struct HomeView: View {
    @ObservedObject private var viewModel = DashboardViewModel.shared
    @ObservedObject private var connectivity = TailscaleConnectivity.shared
    @State private var selectedService: ServiceStatus?

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !connectivity.isLikelyReachable {
                            OfflineBanner()
                        }

                        HostCardsView(hosts: viewModel.dashboard?.hosts ?? [])

                        StatusGridView(
                            statuses: viewModel.dashboard?.status ?? [],
                            onSelect: { selectedService = $0 }
                        )

                        ServiceActivityCard(activity: viewModel.dashboard?.serviceActivity ?? [])

                        if let lastUpdate = viewModel.lastUpdate {
                            Text("Aktualisiert \(FormatterHelper.relativeTime(Int64(lastUpdate.timeIntervalSince1970)))")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.textMuted)
                                .frame(maxWidth: .infinity, alignment: .center)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Homeserver")
            .refreshable {
                await viewModel.fetchDashboard()
            }
            .task {
                viewModel.startAutoRefresh()
            }
            .sheet(item: Binding(
                get: { selectedService.map(ServiceStatusDetailItem.init) },
                set: { selectedService = $0?.status }
            )) { item in
                DetailView(kind: .service(item.status))
            }
        }
    }
}

/// `.sheet(item:)` needs `Identifiable`; this wrapper exists only so two
/// different sheet bindings (Alert vs ServiceStatus) can coexist without
/// either optional accidentally satisfying the other's type.
private struct ServiceStatusDetailItem: Identifiable {
    let status: ServiceStatus
    var id: String { status.id }
}

/// Horizontaler Balken pro Dienst, absteigend nach Traefik-Request-Rate
/// sortiert — Näherung für "wie viel Betrieb ist gerade wo", keine echte
/// Nutzerzählung (Traefik kennt keine Identitäten, siehe
/// Models/ServiceActivity.swift).
private struct ServiceActivityCard: View {
    let activity: [ServiceActivity]

    private var sorted: [ServiceActivity] {
        activity.sorted { $0.requestsPerSecond > $1.requestsPerSecond }
    }

    private var maxRate: Double {
        max(sorted.first?.requestsPerSecond ?? 0, 0.1)
    }

    var body: some View {
        SectionCard(title: "Dienst-Aktivität", systemImage: "chart.bar.fill") {
            if sorted.isEmpty {
                Text("Keine Daten")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            } else {
                VStack(spacing: 10) {
                    ForEach(sorted) { entry in
                        ServiceActivityRow(entry: entry, maxRate: maxRate)
                    }
                }

                Text("Traefik-Request-Rate (5-Min-Mittel) je Dienst — Näherung für Aktivität, keine Nutzerzahl.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}

private struct ServiceActivityRow: View {
    let entry: ServiceActivity
    let maxRate: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Text(String(format: "%.2f req/s", entry.requestsPerSecond))
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundStyle(Theme.textMuted)
            }

            GeometryReader { geo in
                RoundedRectangle(cornerRadius: Theme.radiusSmall / 2, style: .continuous)
                    .fill(Theme.glassBackgroundStrong)
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: Theme.radiusSmall / 2, style: .continuous)
                            .fill(Theme.accentLight)
                            .frame(width: geo.size.width * min(entry.requestsPerSecond / maxRate, 1))
                    }
            }
            .frame(height: 8)
        }
    }
}

private struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
            Text("Homeserver nicht erreichbar — zeige letzten bekannten Stand.")
                .font(.system(size: 13))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.statusWarning.opacity(0.18))
        .foregroundStyle(Theme.statusWarning)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}
