import SwiftUI

/// Left column: ntfy alerts.
struct AlertsGridView: View {
    let alerts: [Alert]
    let onSelect: (Alert) -> Void

    var body: some View {
        SectionCard(title: "Alerts") {
            if alerts.isEmpty {
                Text("No active alerts")
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            } else {
                VStack(spacing: 8) {
                    ForEach(alerts) { alert in
                        Button { onSelect(alert) } label: {
                            AlertRow(alert: alert)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

private struct AlertRow: View {
    let alert: Alert

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: StatusPalette.sfSymbol(for: alert.level))
                .foregroundColor(StatusPalette.color(for: alert.level))
                .font(.system(size: 18))

            VStack(alignment: .leading, spacing: 2) {
                Text(FormatterHelper.truncate(alert.title, maxLength: Constants.maxAlertTitleLength))
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.primary)
                Text(FormatterHelper.truncate(alert.message, maxLength: Constants.maxAlertSubtitleLength))
                    .font(.system(size: 13))
                    .foregroundColor(.secondary)
            }
            Spacer()
        }
        .padding(8)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(8)
    }
}
