import SwiftUI

/// Detail sheet for a tapped alert or service status row.
struct DetailView: View {
    enum Kind: Identifiable {
        case alert(Alert)
        case service(ServiceStatus)

        var id: String {
            switch self {
            case .alert(let alert): return "alert-\(alert.id)"
            case .service(let status): return "service-\(status.id)"
            }
        }
    }

    let kind: Kind
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                switch kind {
                case .alert(let alert):
                    Section {
                        DetailRow("Topic", alert.topic)
                        DetailRow("Level", alert.level.rawValue.capitalized)
                        DetailRow("Empfangen", FormatterHelper.relativeTime(alert.time))
                    }
                    Section("Nachricht") {
                        Text(alert.message)
                            .foregroundStyle(Theme.textPrimary)
                    }
                case .service(let status):
                    Section {
                        DetailRow("Status", status.status.rawValue.capitalized)
                        DetailRow("Ping", FormatterHelper.ping(status.ping))
                        DetailRow("Uptime (24h)", FormatterHelper.uptimePercentage(status.uptime))
                        DetailRow("Letzter Check", FormatterHelper.relativeTime(status.lastCheck))
                    }
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }

    private var title: String {
        switch kind {
        case .alert(let alert): return alert.title
        case .service(let status): return status.name
        }
    }
}

private struct DetailRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack {
            Text(label).foregroundStyle(Theme.textMuted)
            Spacer()
            Text(value).foregroundStyle(Theme.textPrimary)
        }
    }
}
