import Foundation

enum Constants {
    static let apiBaseURL = URL(string: "http://carplay-api.prod.homeserver")!

    static let wolAgentBaseURL = URL(string: "http://100.123.214.4:9102")!

    static let refreshInterval: TimeInterval = 30

    static let requestTimeout: TimeInterval = 10

    static let maxAlertTitleLength = 20
    static let maxAlertSubtitleLength = 30

    enum Keychain {
        static let service = "com.yourname.homeserver-dashboard"
        static let tokenAccount = "carplay-api-bearer-token"
        static let tankerkoenigAPIKeyAccount = "tankerkoenig-api-key"
        static let wolAgentTokenAccount = "vereinsheim-wol-agent-bearer-token"
    }

    enum Weather {
        static let latitude = "50.4205"
        static let longitude = "7.4061"
        static let locationLabel = "Andernach, Deutschland"
        static let openMeteoForecastURL = URL(string: "https://api.open-meteo.com/v1/forecast")!
    }

    enum Tankerkoenig {
        static let baseURL = URL(string: "https://creativecommons.tankerkoenig.de/json")!
        static let nearbySearchRadiusKm = 10
        static let excludedBrands = ["Shell", "Aral", "Esso", "Agip", "Eni"]

        static let fixedStations: [FuelStation] = [
            FuelStation(id: "c40eefd2-1343-48f1-aafe-3e97f46222b0", name: "Andernach", address: "Buchenstraße 1a"),
            FuelStation(id: "effdf24b-44b3-4ddc-9c38-feedb636b05e", name: "Plaidt", address: "An der B 256"),
            FuelStation(id: "40b99699-12d6-48b4-9a90-9d8a9db99ba0", name: "Mülheim-Kärlich", address: "Industriestraße 1"),
        ]
    }

    enum Pegel {
        static let baseURL = URL(string: "https://www.pegelonline.wsv.de/webservices/rest-api/v2")!
        static let stationUUID = "5735892a-ec65-4b29-97c5-50939aa9584e"
        static let stationLabel = "Rhein-Pegel Andernach"
    }

    enum SelfHostedServices {
        static let all: [SelfHostedService] = [
            SelfHostedService(name: "Nextcloud", systemImage: "icloud.fill", host: "nextcloud.prod.homeserver"),
            SelfHostedService(name: "Immich", systemImage: "photo.on.rectangle.angled", host: "immich.prod.homeserver"),
            SelfHostedService(name: "Vaultwarden", systemImage: "lock.fill", host: "vault.tech.homeserver"),
            SelfHostedService(name: "Paperless-ngx", systemImage: "doc.text.magnifyingglass", host: "paperless.prod.homeserver"),
            SelfHostedService(name: "Mealie", systemImage: "fork.knife", host: "mealie.prod.homeserver"),
            SelfHostedService(name: "n8n", systemImage: "arrow.triangle.branch", host: "n8n.prod.homeserver"),
            SelfHostedService(name: "Wiki.js", systemImage: "book.closed.fill", host: "wiki.prod.homeserver"),
            SelfHostedService(name: "Zammad", systemImage: "questionmark.bubble.fill", host: "zammad.tech.homeserver"),
        ]
    }

    enum News {
        static let tagesschauURL = URL(string: "https://www.tagesschau.de/api2u/homepage/")!
        static let heiseFeedURL = URL(string: "https://www.heise.de/rss/heise-atom.xml")!
        static let weltFeedURL = URL(string: "https://www.welt.de/feeds/latest.rss")!
        static let maxSummaryLength = 160
    }
}
