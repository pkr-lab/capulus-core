import Foundation

struct SelfHostedService: Identifiable, Equatable {
    let name: String
    let systemImage: String
    let host: String

    var id: String { host }

    var url: URL { URL(string: "http://\(host)")! }
}
