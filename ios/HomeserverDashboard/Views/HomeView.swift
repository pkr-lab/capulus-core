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

                        UpdatesCard(updates: viewModel.appUpdates)

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
                async let dashboard: Void = viewModel.fetchDashboard()
                async let updates: Void = viewModel.fetchUpdates()
                _ = await (dashboard, updates)
            }
            .task {
                viewModel.startAutoRefresh()
                await viewModel.fetchUpdates()
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

/// Welche self-hosted Apps eine neuere GitHub-Version haben als die in
/// github-release-watcher/values.yaml hinterlegte currentVersion — siehe
/// Models/AppUpdate.swift. hasUpdate == nil (noch keine currentVersion
/// gepflegt) zeigt "unbekannt" statt fälschlich "aktuell".
private struct UpdatesCard: View {
    let updates: [AppUpdate]

    private var available: [AppUpdate] { updates.filter { $0.hasUpdate == true } }
    private var unknown: [AppUpdate] { updates.filter { $0.hasUpdate == nil } }

    var body: some View {
        if !updates.isEmpty {
            SectionCard(title: "Updates", systemImage: "arrow.down.circle.fill") {
                if available.isEmpty {
                    Text("Alle Apps aktuell.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                } else {
                    VStack(spacing: 8) {
                        ForEach(available) { update in
                            UpdateRow(update: update)
                        }
                    }
                }

                if !unknown.isEmpty {
                    Text("Kein bekannter aktueller Stand für \(unknown.map(\.name).joined(separator: ", ")) — currentVersion in github-release-watcher/values.yaml nachtragen.")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
    }
}

private struct UpdateRow: View {
    let update: AppUpdate

    var body: some View {
        Group {
            if let url = update.latestURL {
                Link(destination: url) { content }
            } else {
                content
            }
        }
        .padding(10)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }

    private var content: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(update.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text("\(update.currentVersion ?? "?") → \(update.latestVersion ?? "?")")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer()
            Image(systemName: "arrow.up.circle.fill")
                .foregroundStyle(Theme.statusWarning)
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
