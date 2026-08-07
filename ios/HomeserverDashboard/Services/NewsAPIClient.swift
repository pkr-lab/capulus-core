import Foundation

enum NewsError: LocalizedError {
    case requestFailed
    case parsingFailed

    var errorDescription: String? {
        "Nicht verfügbar"
    }
}

/// One top headline + short summary each from Tagesschau (public JSON),
/// Heise and WELT (public RSS/Atom feeds). These are unversioned third-
/// party feeds outside this repo's control — if a provider changes its
/// schema, that one source fails on its own (NewsView shows "Nicht
/// verfügbar" for it) rather than taking down the whole News page.
final class NewsAPIClient {
    private let session = URLSession(configuration: .default)
    private let decoder = JSONDecoder()

    func getTopHeadline(from source: NewsSource) async throws -> NewsHeadline {
        switch source {
        case .tagesschau:
            return try await fetchTagesschau()
        case .heise:
            return try await fetchFeed(url: Constants.News.heiseFeedURL, source: .heise)
        case .welt:
            return try await fetchFeed(url: Constants.News.weltFeedURL, source: .welt)
        }
    }

    private func fetchTagesschau() async throws -> NewsHeadline {
        let (data, response) = try await session.data(from: Constants.News.tagesschauURL)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw NewsError.requestFailed
        }
        let decoded: TagesschauResponse
        do {
            decoded = try decoder.decode(TagesschauResponse.self, from: data)
        } catch {
            throw NewsError.parsingFailed
        }
        guard let first = decoded.news.first else {
            throw NewsError.parsingFailed
        }
        return NewsHeadline(
            source: .tagesschau,
            title: first.title,
            summary: first.firstSentence.map(Self.cleanSummary),
            link: first.detailsweb.flatMap(URL.init)
        )
    }

    private func fetchFeed(url: URL, source: NewsSource) async throws -> NewsHeadline {
        let (data, response) = try await session.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw NewsError.requestFailed
        }

        let parserDelegate = FeedFirstItemParser()
        let xmlParser = XMLParser(data: data)
        xmlParser.delegate = parserDelegate
        xmlParser.parse()

        guard let item = parserDelegate.firstItem, !item.title.isEmpty else {
            throw NewsError.parsingFailed
        }
        let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = URL(string: item.link.trimmingCharacters(in: .whitespacesAndNewlines))
        let summary = item.description.isEmpty ? nil : Self.cleanSummary(item.description)
        return NewsHeadline(source: source, title: title, summary: summary, link: link)
    }

    /// Feed descriptions routinely carry HTML markup and entities (`<p>`,
    /// `&amp;`, …) meant for a browser, not a plain SwiftUI Text — strip
    /// both down to plain text, then keep it card-sized.
    private static func cleanSummary(_ raw: String) -> String {
        let noTags = raw.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        let decoded = noTags
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&nbsp;", with: " ")
        let collapsedWhitespace = decoded.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return FormatterHelper.truncate(collapsedWhitespace, maxLength: Constants.News.maxSummaryLength)
    }
}

/// Parses just enough of an RSS 2.0 (`<item>`) or Atom (`<entry>`) feed to
/// grab the first item's title/link/description, then aborts — we only
/// ever show one headline per source, no need to parse the whole feed.
private final class FeedFirstItemParser: NSObject, XMLParserDelegate {
    private(set) var firstItem: (title: String, link: String, description: String)?

    private var insideItem = false
    private var currentElement = ""
    private var currentTitle = ""
    private var currentLink = ""
    private var currentDescription = ""

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        guard firstItem == nil else { return }

        if elementName == "item" || elementName == "entry" {
            insideItem = true
            currentTitle = ""
            currentLink = ""
            currentDescription = ""
        }
        currentElement = elementName

        // Atom's <link> is a self-closing element with an href attribute,
        // not text content like RSS 2.0's <link>text</link>.
        if insideItem, elementName == "link", currentLink.isEmpty, let href = attributeDict["href"] {
            currentLink = href
        }
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        appendToCurrentElement(string)
    }

    func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) {
        guard let string = String(data: CDATABlock, encoding: .utf8) else { return }
        appendToCurrentElement(string)
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        guard insideItem, firstItem == nil else { return }

        if elementName == "item" || elementName == "entry" {
            firstItem = (currentTitle, currentLink, currentDescription)
            parser.abortParsing()
        }
    }

    // Called because of the abortParsing() above once the first item's
    // been captured — expected, not a real failure.
    func parser(_ parser: XMLParser, parseErrorOccurred parseError: Error) {}

    private func appendToCurrentElement(_ string: String) {
        switch currentElement {
        case "title": currentTitle += string
        case "link": currentLink += string
        // RSS 2.0 uses <description>, Atom uses <summary> (or <content>
        // for the full body) — both map to the same short-summary field.
        case "description", "summary": currentDescription += string
        default: break
        }
    }
}
