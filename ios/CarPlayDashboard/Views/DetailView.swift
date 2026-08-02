import SwiftUI

/// Phone-side counterpart to CarPlaySceneDelegate's CPInformationTemplate
/// detail push — same data, presented as a sheet instead of a CarPlay
/// template.
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
                        DetailRow("Received", FormatterHelper.relativeTime(alert.time))
                    }
                    Section("Message") {
                        Text(alert.message)
                    }
                case .service(let status):
                    Section {
                        DetailRow("Status", status.status.rawValue.capitalized)
                        DetailRow("Ping", FormatterHelper.ping(status.ping))
                        DetailRow("Uptime (24h)", FormatterHelper.uptimePercentage(status.uptime))
                        DetailRow("Last check", FormatterHelper.relativeTime(status.lastCheck))
                    }
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
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

/// `LabeledContent` needs iOS 16 — this project's deployment target is
/// iOS 15.0, so a plain HStack stands in for it.
private struct DetailRow: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value)
        }
    }
}
