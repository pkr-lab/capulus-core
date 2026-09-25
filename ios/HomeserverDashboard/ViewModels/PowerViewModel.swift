import Foundation

@MainActor
final class PowerViewModel: ObservableObject {
    static let shared = PowerViewModel()

    @Published var brightness: Int?
    @Published var isLoadingBrightness = false
    @Published var brightnessError: String?

    @Published var pendingAction: PowerTarget?
    @Published var actionError: String?
    @Published var lastActionSucceeded: PowerTarget?

    @Published var pendingRemoteWol: RemoteWolTarget?
    @Published var remoteWolError: String?
    @Published var lastRemoteWolSucceeded: RemoteWolTarget?

    private let apiClient = HomeserverAPIClient()
    private let wolAgentClient = RemoteWolAgentClient()

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

    func wakeRemote(_ target: RemoteWolTarget) async {
        pendingRemoteWol = target
        remoteWolError = nil
        do {
            try await wolAgentClient.wake(target)
            lastRemoteWolSucceeded = target
        } catch {
            remoteWolError = error.localizedDescription
        }
        pendingRemoteWol = nil
    }
}
