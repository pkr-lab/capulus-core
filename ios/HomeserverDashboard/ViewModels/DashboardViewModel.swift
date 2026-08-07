import Combine
import Foundation

/// Single shared source of dashboard state for the app's tabs — one
/// instance means one 30s polling loop total, not one per screen.
@MainActor
final class DashboardViewModel: ObservableObject {
    static let shared = DashboardViewModel()

    @Published private(set) var dashboard: DashboardPayload?
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published private(set) var lastUpdate: Date?

    @Published private(set) var appUpdates: [AppUpdate] = []

    private var refreshTask: Task<Void, Never>?
    private let apiClient = HomeserverAPIClient()
    private let refreshInterval: TimeInterval = Constants.refreshInterval

    private init() {}

    func startAutoRefresh() {
        guard refreshTask == nil else { return }

        refreshTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.fetchDashboard()
                try? await Task.sleep(nanoseconds: UInt64(self.refreshInterval * 1_000_000_000))
            }
        }
    }

    func stopAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    func fetchDashboard() async {
        isLoading = true
        error = nil

        do {
            let newDashboard = try await apiClient.getDashboard()
            dashboard = newDashboard
            lastUpdate = Date()
        } catch {
            // Deliberately keep the last-known `dashboard` value on failure
            // (see README "Offline-Verhalten") — a stale reading beats a
            // blank screen.
            self.error = String(describing: error as NSError)
        }

        isLoading = false
    }

    /// Not part of the 30s auto-refresh loop — carplay-api caches this for
    /// 15 min server-side and the watcher behind it only runs every 2h, so
    /// polling it that often would just hit the cache for nothing. Called
    /// once per HomeView appearance / pull-to-refresh instead.
    func fetchUpdates() async {
        do {
            appUpdates = try await apiClient.getUpdates().repos
        } catch {
            // Silent failure by design: this is a "nice to know" card, not
            // core dashboard data — an error here shouldn't show a banner
            // on top of the fleet overview. Just keep the last-known list.
        }
    }
}
