import SwiftUI

/// News-Seite im Alltag-Modus: je eine Top-Meldung von Tagesschau, Heise
/// und WELT. Tippen öffnet den Artikel in Safari.
struct NewsView: View {
    @State private var headlines: [NewsSource: NewsHeadline] = [:]
    @State private var errors: [NewsSource: String] = [:]
    @State private var isLoading = false

    private let client = NewsAPIClient()

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(spacing: 16) {
                        NewsCard(source: .tagesschau, systemImage: "tv.fill", headline: headlines[.tagesschau], error: errors[.tagesschau], isLoading: isLoading)
                        NewsCard(source: .heise, systemImage: "cpu", headline: headlines[.heise], error: errors[.heise], isLoading: isLoading)
                        NewsCard(source: .welt, systemImage: "newspaper.fill", headline: headlines[.welt], error: errors[.welt], isLoading: isLoading)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("News")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        errors = [:]
        async let t: Void = loadHeadline(.tagesschau)
        async let h: Void = loadHeadline(.heise)
        async let w: Void = loadHeadline(.welt)
        _ = await (t, h, w)
        isLoading = false
    }

    private func loadHeadline(_ source: NewsSource) async {
        do {
            headlines[source] = try await client.getTopHeadline(from: source)
        } catch {
            errors[source] = error.localizedDescription
        }
    }
}

private struct NewsCard: View {
    let source: NewsSource
    let systemImage: String
    let headline: NewsHeadline?
    let error: String?
    let isLoading: Bool

    var body: some View {
        SectionCard(title: source.rawValue, systemImage: systemImage) {
            if let headline {
                Group {
                    if let link = headline.link {
                        Link(destination: link) {
                            content(for: headline)
                        }
                    } else {
                        content(for: headline)
                    }
                }
            } else if isLoading {
                ProgressView()
                    .tint(Theme.textPrimary)
                    .frame(maxWidth: .infinity)
            } else {
                Text(error ?? "Keine Meldung verfügbar")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }

    private func content(for headline: NewsHeadline) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(headline.title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)

            if let summary = headline.summary {
                Text(summary)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
