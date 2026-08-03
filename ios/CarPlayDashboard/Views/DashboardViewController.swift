import SwiftUI

/// Phone companion screen. CarPlay (CarPlaySceneDelegate) is the actual
/// point of this app; this view exists because Apple requires every app to
/// have a substantive non-CarPlay UI too — it doubles as a convenient way
/// to check the dashboard, add/replace the API token, and see the same
/// data without being in the car.
struct DashboardViewController: View {
    @ObservedObject private var viewModel = DashboardViewModel.shared
    @ObservedObject private var connectivity = TailscaleConnectivity.shared
    @State private var selectedAlert: Alert?
    @State private var selectedService: ServiceStatus?
    @State private var showingSettings = false

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !connectivity.isLikelyReachable {
                        OfflineBanner()
                    }

                    AlertsGridView(
                        alerts: viewModel.dashboard?.alerts ?? [],
                        onSelect: { selectedAlert = $0 }
                    )
                    MetricsGridView(metrics: viewModel.dashboard?.metrics ?? .placeholder)
                    StatusGridView(
                        statuses: viewModel.dashboard?.status ?? [],
                        onSelect: { selectedService = $0 }
                    )

                    if let lastUpdate = viewModel.lastUpdate {
                        Text("Updated \(FormatterHelper.relativeTime(Int64(lastUpdate.timeIntervalSince1970)))")
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .padding(12)
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

/// CPListItem-style selection needs `Identifiable` sheet items;
/// `ServiceStatus` already conforms, this wrapper exists only so two
/// different `.sheet(item:)` bindings (Alert vs ServiceStatus) can coexist
/// without either optional accidentally satisfying the other's type.
private struct ServiceStatusDetailItem: Identifiable {
    let status: ServiceStatus
    var id: String { status.id }
}

/// Shared "titled card" wrapper for the three columns (Alerts/Metrics/Status)
/// — used by AlertsGridView, MetricsGridView and StatusGridView.
struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 18, weight: .bold))
            content()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground))
        .cornerRadius(8)
    }
}

private struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
            Text("Can't reach the homeserver — showing last known data.")
                .font(.system(size: 13))
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(StatusPalette.uiColor(for: .warning)).opacity(0.15))
        .foregroundColor(Color(StatusPalette.uiColor(for: .warning)))
        .cornerRadius(8)
    }
}
