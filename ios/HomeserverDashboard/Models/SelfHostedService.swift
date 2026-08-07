import Foundation

/// One tile in the "Dienste" grid (Alltag-Modus) — see
/// Constants.SelfHostedServices.
struct SelfHostedService: Identifiable, Equatable {
    let name: String
    let systemImage: String
    let host: String

    var id: String { host }

    /// Plain HTTP, same as every other *.homeserver service (see
    /// Constants.apiBaseURL) — opened via Safari, not this app's own
    /// URLSession, so the NSAppTransportSecurity exception for "homeserver"
    /// doesn't even come into play here.
    var url: URL { URL(string: "http://\(host)")! }
}
