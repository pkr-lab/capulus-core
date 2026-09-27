import Combine
import Foundation

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
            self.error = String(describing: error as NSError)
        }

        isLoading = false
    }

    func fetchUpdates() async {
        do {
            appUpdates = try await apiClient.getUpdates().repos
        } catch {
        }
    }
}
