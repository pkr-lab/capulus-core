import Foundation
import Security

final class MTLSDelegate: NSObject, URLSessionDelegate {
    private static let pinnedHostSuffix = ".homeserver"
    private static let pinnedHosts: Set<String> = ["100.123.214.4"]

    private static let rootCertificate: SecCertificate? = {
        guard let url = Bundle.main.url(forResource: "homeserver-root-ca", withExtension: "pem"),
              let pem = try? String(contentsOf: url, encoding: .utf8) else {
            return nil
        }
        let base64 = pem
            .split(whereSeparator: \.isNewline)
            .filter { !$0.hasPrefix("-----") }
            .joined()
        guard let der = Data(base64Encoded: base64) else {
            return nil
        }
        return SecCertificateCreateWithData(nil, der as CFData)
    }()

    private static func isPinnedHost(_ host: String) -> Bool {
        pinnedHosts.contains(host) || host.hasSuffix(pinnedHostSuffix)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              Self.isPinnedHost(space.host),
              let trust = space.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard let root = Self.rootCertificate else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        SecTrustSetAnchorCertificates(trust, [root] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)

        var error: CFError?
        if SecTrustEvaluateWithError(trust, &error) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
