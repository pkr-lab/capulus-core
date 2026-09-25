import Foundation

final class RemoteWolAgentClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = Constants.wolAgentBaseURL) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Constants.requestTimeout
        config.waitsForConnectivity = false

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
