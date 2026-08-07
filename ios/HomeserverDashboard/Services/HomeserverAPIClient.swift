import Foundation

enum APIError: LocalizedError {
    case badResponse(statusCode: Int, message: String?)
    case decodingFailed(Error)
    case missingToken

    var errorDescription: String? {
        switch self {
        case .badResponse(let statusCode, let message):
            return message ?? "carplay-api returned HTTP \(statusCode)"
        case .decodingFailed(let error):
            return "Could not parse response: \(error.localizedDescription)"
        case .missingToken:
            return "No API token stored in Keychain — open Settings to add one."
        }
    }
}

/// Talks to carplay-api. See Constants.swift and MTLSDelegate.swift for why
/// this is plain HTTP + Bearer token today rather than HTTPS + client
/// certificate.
final class HomeserverAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL = Constants.apiBaseURL) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.requestTimeout
        // waitsForConnectivity previously caused spurious NSURLErrorCancelled
        // (-999) on every request: with Tailscale's VPN interface reported
        // as a constantly-changing network path, URLSession would start
        // "waiting", detect a path change, and cancel the wait instead of
        // just retrying — surfacing as an unexplained "cancelled" with no
        // underlying error. Failing fast (default false) lets our own
        // 30s-interval polling loop be the retry mechanism instead.
        config.waitsForConnectivity = false

        self.session = URLSession(configuration: config, delegate: MTLSDelegate(), delegateQueue: nil)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    func getDashboard() async throws -> DashboardPayload {
        let (data, _) = try await request(method: "GET", path: "/api/dashboard")
        return try decode(DashboardPayload.self, from: data)
    }

    func getBrightness() async throws -> Int {
        let (data, _) = try await request(method: "GET", path: "/api/brightness")
        return try decode(BrightnessResponse.self, from: data).percent
    }

    func setBrightness(percent: Int) async throws -> Int {
        let body = try encoder.encode(BrightnessRequestBody(percent: percent))
        let (data, _) = try await request(method: "PUT", path: "/api/brightness", jsonBody: body)
        return try decode(BrightnessResponse.self, from: data).percent
    }

    func wake(target: PowerTarget) async throws {
        let body = try encoder.encode(WakeRequestBody(target: target.rawValue))
        _ = try await request(method: "POST", path: "/api/power/wake", jsonBody: body)
    }

    /// `code` is required (and checked server-side) only when `target ==
    /// .homeserver` — see docs/43-carplay-api.md and PowerView's
    /// confirmation sheet.
    func shutdown(target: PowerTarget, code: String? = nil) async throws {
        let body = try encoder.encode(ShutdownRequestBody(target: target.rawValue, code: code))
        _ = try await request(method: "POST", path: "/api/power/shutdown", jsonBody: body)
    }

    // MARK: - Request plumbing

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingFailed(error)
        }
    }

    /// Builds, sends and status-checks one request. Returns the raw body on
    /// success so each call site decodes into its own response type (some
    /// endpoints, like wake/shutdown, have no body worth decoding at all).
    private func request(method: String, path: String, jsonBody: Data? = nil) async throws -> (Data, HTTPURLResponse) {
        var urlRequest = URLRequest(url: baseURL.appendingPathComponent(path))
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = Constants.requestTimeout

        if let token = try? KeychainService.shared.getToken() {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let jsonBody {
            urlRequest.httpBody = jsonBody
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        // Deliberately the completion-handler API, not the `async`
        // convenience `session.data(for:)`: over Tailscale's VPN tunnel
        // (NEPacketTunnelProvider), the async variant was observed cancelling
        // every single request with a bare NSURLErrorCancelled (-999) and no
        // underlying error — a known async/await-bridging + packet-tunnel
        // interaction. The completion-handler API doesn't have this problem.
        let (data, response): (Data, URLResponse) = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, URLResponse), Error>) in
            let task = session.dataTask(with: urlRequest) { data, response, error in
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

        do {
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                TailscaleConnectivity.shared.recordRequestResult(succeeded: false)
                let message = (try? decoder.decode(ErrorBody.self, from: data))?.error
                throw APIError.badResponse(statusCode: status, message: message)
            }
            TailscaleConnectivity.shared.recordRequestResult(succeeded: true)
            return (data, httpResponse)
        } catch let error as APIError {
            throw error
        } catch {
            TailscaleConnectivity.shared.recordRequestResult(succeeded: false)
            throw error
        }
    }
}

private struct ErrorBody: Decodable {
    let error: String
}

private struct BrightnessRequestBody: Encodable {
    let percent: Int
}

private struct WakeRequestBody: Encodable {
    let target: String
}

private struct ShutdownRequestBody: Encodable {
    let target: String
    let code: String?
}
