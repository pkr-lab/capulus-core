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

final class HomeserverAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL = Constants.apiBaseURL) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.requestTimeout
        config.waitsForConnectivity = false

        self.session = URLSession(configuration: config, delegate: MTLSDelegate(), delegateQueue: nil)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    func getDashboard() async throws -> DashboardPayload {
        let (data, _) = try await request(method: "GET", path: "/api/dashboard")
        return try decode(DashboardPayload.self, from: data)
    }

    func getUpdates() async throws -> UpdatesResponse {
        let (data, _) = try await request(method: "GET", path: "/api/updates")
        return try decode(UpdatesResponse.self, from: data)
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
