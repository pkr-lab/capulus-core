import Combine
import Foundation

/// Single shared source of dashboard state for both the phone UI
/// (SwiftUI, via `@Published`) and the CarPlay templates (via
/// `onUpdate`, since CPListTemplate isn't SwiftUI and can't just bind to a
/// `@Published` property). One shared instance means one 30s polling loop
/// total, not one per scene.
@MainActor
final class DashboardViewModel: ObservableObject {
    static let shared = DashboardViewModel()

    @Published private(set) var dashboard: CarPlayDashboard?
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published private(set) var lastUpdate: Date?

    /// Called on every successful fetch, on the main actor — CarPlaySceneDelegate
    /// registers here to push fresh data into its templates.
    var onUpdate: ((CarPlayDashboard) -> Void)?

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
            onUpdate?(newDashboard)
        } catch {
            // Deliberately keep the last-known `dashboard` value on failure
            // (see README "Offline-Verhalten") — a stale reading beats a
            // blank screen while driving.
            self.error = error.localizedDescription
        }

        isLoading = false
    }
}
