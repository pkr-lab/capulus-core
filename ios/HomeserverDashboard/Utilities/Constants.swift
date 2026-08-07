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

    /// Keep alert titles/subtitles short so they don't get truncated
    /// mid-word by the system on narrower cards.
    static let maxAlertTitleLength = 20
    static let maxAlertSubtitleLength = 30

    enum Keychain {
        static let service = "com.yourname.homeserver-dashboard"
        static let tokenAccount = "carplay-api-bearer-token"
        static let tankerkoenigAPIKeyAccount = "tankerkoenig-api-key"
    }

    /// Same location Glance's two Wetter-Widgets use (see
    /// argocd/apps/glance/values.yaml `weather:`) — Andernach.
    enum Weather {
        static let latitude = "50.4205"
        static let longitude = "7.4061"
        static let locationLabel = "Andernach, Deutschland"
        static let openMeteoForecastURL = URL(string: "https://api.open-meteo.com/v1/forecast")!
    }

    /// Same public API and fixed stations Glance's "Tankpreise"-Widget uses
    /// (see argocd/apps/glance/templates/configmap.yaml + _helpers.tpl),
    /// queried directly from the app with its own API key instead of
    /// through Glance's cluster-side sealed secret.
    enum Tankerkoenig {
        static let baseURL = URL(string: "https://creativecommons.tankerkoenig.de/json")!
        static let nearbySearchRadiusKm = 10
        // Agip rebranded to Eni in Germany — Tankerkönig data has been seen
        // under both names, so both are excluded.
        static let excludedBrands = ["Shell", "Aral", "Esso", "Agip", "Eni"]

        static let fixedStations: [FuelStation] = [
            FuelStation(id: "c40eefd2-1343-48f1-aafe-3e97f46222b0", name: "Andernach", address: "Buchenstraße 1a"),
            FuelStation(id: "effdf24b-44b3-4ddc-9c38-feedb636b05e", name: "Plaidt", address: "An der B 256"),
            FuelStation(id: "40b99699-12d6-48b4-9a90-9d8a9db99ba0", name: "Mülheim-Kärlich", address: "Industriestraße 1"),
        ]
    }

    /// One headline each, no API key needed: Tagesschau's public (if
    /// unofficial) JSON endpoint, plus Heise's and WELT's public RSS/Atom
    /// feeds. Feed URLs/schemas aren't versioned by their providers — if one
    /// changes shape, NewsAPIClient fails closed per-source (see its
    /// doc comment) rather than crashing the page.
    enum News {
        static let tagesschauURL = URL(string: "https://www.tagesschau.de/api2u/homepage/")!
        static let heiseFeedURL = URL(string: "https://www.heise.de/rss/heise-atom.xml")!
        static let weltFeedURL = URL(string: "https://www.welt.de/feeds/latest.rss")!
        static let maxSummaryLength = 160
    }
}
