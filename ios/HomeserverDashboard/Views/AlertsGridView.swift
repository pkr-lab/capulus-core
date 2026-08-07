import SwiftUI

/// ntfy alerts, most recent first.
struct AlertsGridView: View {
    let alerts: [Alert]
    let onSelect: (Alert) -> Void

    var body: some View {
        SectionCard(title: "Alerts", systemImage: "bell.fill") {
            if alerts.isEmpty {
                Text("Keine aktiven Alerts")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
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
                .foregroundStyle(StatusPalette.color(for: alert.level))
                .font(.system(size: 18))

            VStack(alignment: .leading, spacing: 2) {
                Text(FormatterHelper.truncate(alert.title, maxLength: Constants.maxAlertTitleLength))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Text(FormatterHelper.truncate(alert.message, maxLength: Constants.maxAlertSubtitleLength))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer()
        }
        .padding(10)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}
