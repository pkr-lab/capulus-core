import Foundation

/// One watched repo's update status. Mirrors `models.AppUpdate` /
/// `models.UpdatesResponse` in carplay-api, itself sourced from github-
/// release-watcher's updates ConfigMap (argocd/apps/github-release-
/// watcher). Optional fields are nil when unknown — e.g. `hasUpdate` stays
/// nil (not false) whenever `currentVersion` hasn't been filled in on the
/// backend, so the UI can show "unbekannt" instead of a false "aktuell".
struct AppUpdate: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let repo: String
    let currentVersion: String?
    let latestVersion: String?
    let latestURL: URL?
    let hasUpdate: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, repo
        case currentVersion = "current_version"
        case latestVersion = "latest_version"
        case latestURL = "latest_url"
        case hasUpdate = "has_update"
    }
}

struct UpdatesResponse: Codable, Equatable {
    let updatedAt: Int64
    let repos: [AppUpdate]

    enum CodingKeys: String, CodingKey {
        case updatedAt = "updated_at"
        case repos
    }
}
