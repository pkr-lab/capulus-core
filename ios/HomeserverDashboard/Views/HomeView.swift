import SwiftUI

/// The app's start screen: a short, visual overview of the fleet's
/// metrics — Homeserver, NAS, worker-0, worker-1, whichever of those are
/// currently on — plus alerts and service status.
struct HomeView: View {
    @ObservedObject private var viewModel = DashboardViewModel.shared
    @ObservedObject private var connectivity = TailscaleConnectivity.shared
    @State private var selectedAlert: Alert?
    @State private var selectedService: ServiceStatus?
    @State private var showingSettings = false

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !connectivity.isLikelyReachable {
                            OfflineBanner()
                        }

                        HostCardsView(hosts: viewModel.dashboard?.hosts ?? [])

                        AlertsGridView(
                            alerts: viewModel.dashboard?.alerts ?? [],
                            onSelect: { selectedAlert = $0 }
                        )
                        StatusGridView(
                            statuses: viewModel.dashboard?.status ?? [],
                            onSelect: { selectedService = $0 }
                        )

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
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .refreshable {
                await viewModel.fetchDashboard()
            }
            .task {
                viewModel.startAutoRefresh()
            }
            .sheet(item: $selectedAlert) { alert in
                DetailView(kind: .alert(alert))
            }
            .sheet(item: Binding(
                get: { selectedService.map(ServiceStatusDetailItem.init) },
                set: { selectedService = $0?.status }
            )) { item in
                DetailView(kind: .service(item.status))
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
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
