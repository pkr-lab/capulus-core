import Foundation

/// URLSessionDelegate for carplay-api's connection.
///
/// The original spec asked for TLS client-certificate pinning here. As
/// deployed today, `carplay-api.homeserver` is plain HTTP like every other
/// *.homeserver service in this cluster (see Constants.swift) — there is no
/// TLS handshake to pin a certificate against, so implementing pinning here
/// would just be a check that never runs. Real client-certificate mTLS
/// *is* a documented plan for this cluster (docs/14-cert-login.md, home-lab
/// CA + `RequireAndVerifyClientCert` at the Traefik layer) but it isn't
/// merged, and so far only targets a handful of admin UIs (Authentik,
/// Grafana, ...), not this API.
///
/// This delegate is kept as the extension point for when/if that migration
/// reaches carplay-api: once its IngressRoute references the `mtls-homelab`
/// TLSOption, uncomment the client-identity branch below, ship the device's
/// `.p12` client certificate via Keychain (see KeychainService.swift), and
/// switch Constants.apiBaseURL back to `https://`.
final class MTLSDelegate: NSObject, URLSessionDelegate {
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        // No server-trust pinning or client identity configured today —
        // fall back to the system's default TLS/ATS handling.
        //
        // Future mTLS wiring, once carplay-api's ingress requires a client
        // cert:
        //
        //   guard let identity = KeychainService.shared.clientIdentity() else {
        //       completionHandler(.performDefaultHandling, nil)
        //       return
        //   }
        //   let credential = URLCredential(identity: identity, certificates: nil, persistence: .forSession)
        //   completionHandler(.useCredential, credential)

        completionHandler(.performDefaultHandling, nil)
    }
}
