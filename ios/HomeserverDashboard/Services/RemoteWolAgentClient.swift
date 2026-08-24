import Foundation

/// Talks directly to the small HTTP agent running on
/// vereinsheim-alarmmonitor itself (`banana_pi_kiosk` role,
/// `banana-pi-wol-agent.py`) — deliberately NOT routed through
/// carplay-api, since that pod has no network path to Tailscale peers
/// (see docs/4-planung/40020-vereinsheim-wol-router-vpn.md in
/// capulus-core). Reachable only while Tailscale is up on this device,
/// same as HomeserverAPIClient.
///
/// Duplicates HomeserverAPIClient's completion-handler request plumbing
/// on purpose rather than sharing it: that workaround (see its comment
/// on `waitsForConnectivity` / NSURLErrorCancelled) is tied to a
/// specific, already-fragile Tailscale/URLSession interaction — keeping
/// the two clients independent means a future fix to one doesn't risk
/// silently breaking the other.
final class RemoteWolAgentClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = Constants.wolAgentBaseURL) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.requestTimeout
        config.waitsForConnectivity = false // see HomeserverAPIClient.swift

        self.session = URLSession(configuration: config, delegate: MTLSDelegate(), delegateQueue: nil)
    }

    func wake(_ target: RemoteWolTarget) async throws {
        guard let token = try? KeychainService.shared.getWolAgentToken() else {
            throw APIError.missingToken
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("/wol"))
        request.httpMethod = "POST"
        request.timeoutInterval = Constants.requestTimeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(WakeRequestBody(target: target.rawValue))

        // Completion-handler API, not the `async` convenience
        // `session.data(for:)` — see HomeserverAPIClient.swift's
        // request(method:path:jsonBody:) for why (NSURLErrorCancelled
        // over Tailscale's packet tunnel).
        let (data, response): (Data, URLResponse) = try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let data, let response else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                    return
                }
                continuation.resume(returning: (data, response))
            }
            task.resume()
        }

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
            throw APIError.badResponse(statusCode: status, message: message)
        }
    }
}

private struct WakeRequestBody: Encodable {
    let target: String
}

private struct ErrorBody: Decodable {
    let error: String
}
