import Foundation

enum Constants {
    /// Base URL of carplay-api. Every *.homeserver service in this cluster
    /// is plain HTTP behind Traefik (see argocd/apps/*/values.yaml —
    /// ingress.tls is empty everywhere; HTTPS/mTLS is a documented but
    /// not-yet-merged migration, docs/14-cert-login.md, so far only
    /// targeting a handful of admin UIs). Matching that live reality
    /// instead of pretending HTTPS is already there — see Info.plist's
    /// NSAppTransportSecurity exception for the "homeserver" domain, and
    /// MTLSDelegate.swift for what "secure" actually means here today.
    /// Reachable only while Tailscale is up (see
    /// TailscaleConnectivity.swift). Override at runtime via Settings if
    /// your ingress host differs (see README "Configuration").
    static let apiBaseURL = URL(string: "http://carplay-api.homeserver")!

    static let refreshInterval: TimeInterval = 30

    static let requestTimeout: TimeInterval = 10

    /// CarPlay list rows are narrow — keep titles/subtitles short so they
    /// don't get truncated mid-word by the system.
    static let maxAlertTitleLength = 20
    static let maxAlertSubtitleLength = 30

    enum Keychain {
        static let service = "com.yourname.homeserver-carplay"
        static let tokenAccount = "carplay-api-bearer-token"
    }
}
