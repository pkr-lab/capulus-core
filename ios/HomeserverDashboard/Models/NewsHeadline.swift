import Foundation

enum NewsSource: String, CaseIterable {
    case tagesschau = "Tagesschau"
    case heise = "Heise"
    case welt = "WELT"
}

struct NewsHeadline {
    let source: NewsSource
    let title: String
    let summary: String?
    let link: URL?
}

struct TagesschauResponse: Decodable {
    let news: [Item]

    struct Item: Decodable {
        let title: String
        let firstSentence: String?
        let detailsweb: String?
    }
}
