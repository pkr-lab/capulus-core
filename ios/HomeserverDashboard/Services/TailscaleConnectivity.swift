import Combine
import Foundation
import Network

/// Tracks whether the network path carplay-api needs is currently up.
///
/// iOS has no public API to ask "is Tailscale connected" — VPN status of a
/// third-party app isn't exposed to other apps. This does the next best
/// thing: watches the general network path (`NWPathMonitor`) so the UI can
/// show "offline" immediately instead of waiting for a request to time out,
/// and separately tracks whether the *last actual request* to carplay-api
/// succeeded, which is the only real signal that Tailscale + the API are
/// both reachable end to end.
final class TailscaleConnectivity: ObservableObject {
    static let shared = TailscaleConnectivity()

    @Published private(set) var hasNetworkPath = true
    @Published private(set) var lastRequestSucceeded = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.yourname.homeserver-dashboard.pathmonitor")

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.hasNetworkPath = path.status == .satisfied
            }
        }
        monitor.start(queue: queue)
    }

    func recordRequestResult(succeeded: Bool) {
        DispatchQueue.main.async {
            self.lastRequestSucceeded = succeeded
        }
    }

    var isLikelyReachable: Bool {
        hasNetworkPath && lastRequestSucceeded
    }
}
