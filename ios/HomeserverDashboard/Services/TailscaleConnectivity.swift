import Combine
import Foundation
import Network

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
