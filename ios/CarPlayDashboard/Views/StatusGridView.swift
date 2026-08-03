import SwiftUI

/// Right column: Uptime-Kuma service status.
struct StatusGridView: View {
    let statuses: [ServiceStatus]
    let onSelect: (ServiceStatus) -> Void

    var body: some View {
        SectionCard(title: "Status") {
            if statuses.isEmpty {
                Text("No monitors configured")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            } else {
                VStack(spacing: 8) {
                    ForEach(statuses) { status in
                        Button { onSelect(status) } label: {
                            StatusRow(status: status)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

private struct StatusRow: View {
    let status: ServiceStatus

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: StatusPalette.sfSymbol(for: status.status))
                .foregroundColor(StatusPalette.color(for: status.status))
                .font(.system(size: 24))

            VStack(alignment: .leading, spacing: 2) {
                Text(status.name)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.primary)
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding(8)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(8)
    }

    private var subtitle: String {
        switch status.status {
        case .up:
            return "UP · \(FormatterHelper.ping(status.ping)) · \(FormatterHelper.uptimePercentage(status.uptime))"
        case .down:
            return "DOWN"
        case .maintenance:
            return "MAINTENANCE"
        case .paused:
            return "PAUSED"
        }
    }
}
