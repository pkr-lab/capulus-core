import SwiftUI

struct AlertsView: View {
    @ObservedObject private var viewModel = DashboardViewModel.shared
    @State private var selectedAlert: Alert?

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    AlertsGridView(
                        alerts: viewModel.dashboard?.alerts ?? [],
                        onSelect: { selectedAlert = $0 }
                    )
                    .padding(16)
                }
            }
            .navigationTitle("Alerts")
            .refreshable {
                await viewModel.fetchDashboard()
            }
            .sheet(item: $selectedAlert) { alert in
                DetailView(kind: .alert(alert))
            }
        }
    }
}
