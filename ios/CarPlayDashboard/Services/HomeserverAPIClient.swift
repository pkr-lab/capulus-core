import Foundation

enum APIError: LocalizedError {
    case badResponse(statusCode: Int)
    case decodingFailed(Error)
    case missingToken

    var errorDescription: String? {
        switch self {
        case .badResponse(let statusCode):
            return "carplay-api returned HTTP \(statusCode)"
        case .decodingFailed(let error):
            return "Could not parse dashboard response: \(error.localizedDescription)"
        case .missingToken:
            return "No API token stored in Keychain — open Settings to add one."
        }
    }
}

/// Talks to `GET /api/dashboard` on carplay-api. See Constants.swift and
/// MTLSDelegate.swift for why this is plain HTTP + Bearer token today
/// rather than HTTPS + client certificate.
final class HomeserverAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL = Constants.apiBaseURL) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.requestTimeout
        config.waitsForConnectivity = true

        self.session = URLSession(configuration: config, delegate: MTLSDelegate(), delegateQueue: nil)
        self.decoder = JSONDecoder()
    }

    func getDashboard() async throws -> CarPlayDashboard {
        var request = URLRequest(url: baseURL.appendingPathComponent("/api/dashboard"))
        request.timeoutInterval = Constants.requestTimeout

        if let token = try? KeychainService.shared.getToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                TailscaleConnectivity.shared.recordRequestResult(succeeded: false)
                throw APIError.badResponse(statusCode: status)
            }

            TailscaleConnectivity.shared.recordRequestResult(succeeded: true)

            do {
                return try decoder.decode(CarPlayDashboard.self, from: data)
            } catch {
                throw APIError.decodingFailed(error)
            }
        } catch let error as APIError {
            throw error
        } catch {
            TailscaleConnectivity.shared.recordRequestResult(succeeded: false)
            throw error
        }
    }
}
