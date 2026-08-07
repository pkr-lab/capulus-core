import SwiftUI

/// Uptime-Kuma service status.
struct StatusGridView: View {
    let statuses: [ServiceStatus]
    let onSelect: (ServiceStatus) -> Void

    var body: some View {
        SectionCard(title: "Status", systemImage: "checkmark.shield.fill") {
            if statuses.isEmpty {
                Text("Keine Monitore konfiguriert")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
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
                .foregroundStyle(StatusPalette.color(for: status.status))
                .font(.system(size: 22))

            VStack(alignment: .leading, spacing: 2) {
                Text(status.name)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer()
        }
        .padding(10)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
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
