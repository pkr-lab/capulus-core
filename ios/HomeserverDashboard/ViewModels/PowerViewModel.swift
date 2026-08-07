import Foundation

/// Backs the Brightness and Power tabs: brightness get/set and
/// wake/shutdown actions, all proxied by carplay-api to power-agent on the
/// homeserver host (see docs/43-carplay-api.md "power-agent"). Kept
/// separate from DashboardViewModel since these are user-triggered actions
/// with their own loading/error state, not part of the 30s polling loop.
@MainActor
final class PowerViewModel: ObservableObject {
    static let shared = PowerViewModel()

    @Published var brightness: Int?
    @Published var isLoadingBrightness = false
    @Published var brightnessError: String?

    @Published var pendingAction: PowerTarget?
    @Published var actionError: String?
    @Published var lastActionSucceeded: PowerTarget?

    private let apiClient = HomeserverAPIClient()

    private init() {}

    func loadBrightness() async {
        isLoadingBrightness = true
        brightnessError = nil
        do {
            brightness = try await apiClient.getBrightness()
        } catch {
            brightnessError = error.localizedDescription
        }
        isLoadingBrightness = false
    }

    /// Called as the slider moves — optimistic local update so the UI
    /// doesn't lag behind the finger, reconciled with the server's clamped
    /// value once the request lands.
    func setBrightness(percent: Int) async {
        brightness = percent
        do {
            brightness = try await apiClient.setBrightness(percent: percent)
        } catch {
            brightnessError = error.localizedDescription
        }
    }

    func wake(_ target: PowerTarget) async {
        pendingAction = target
        actionError = nil
        do {
            try await apiClient.wake(target: target)
            lastActionSucceeded = target
        } catch {
            actionError = error.localizedDescription
        }
        pendingAction = nil
        await DashboardViewModel.shared.fetchDashboard()
    }

    /// `code` must be non-nil (and correct) for `.homeserver` — see
    /// PowerView's confirmation sheet, which is the only caller that ever
    /// passes one.
    func shutdown(_ target: PowerTarget, code: String? = nil) async {
        pendingAction = target
        actionError = nil
        do {
            try await apiClient.shutdown(target: target, code: code)
            lastActionSucceeded = target
        } catch {
            actionError = error.localizedDescription
        }
        pendingAction = nil
        await DashboardViewModel.shared.fetchDashboard()
    }
}
