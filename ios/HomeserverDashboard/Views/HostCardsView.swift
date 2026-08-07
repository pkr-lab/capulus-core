import SwiftUI

/// Visual overview of every monitored machine — Homeserver, NAS, worker-0,
/// worker-1 — but only the ones currently on. An offline host (whether
/// it's a worker that's been scaled down, or the NAS mid-reboot) is
/// omitted entirely rather than shown grayed out at 0%, since 0% for an
/// offline host isn't a real reading.
struct HostCardsView: View {
    let hosts: [HostMetrics]

    private var onlineHosts: [HostMetrics] {
        hosts.filter(\.online)
    }

    var body: some View {
        SectionCard(title: "Hosts", systemImage: "server.rack") {
            if onlineHosts.isEmpty {
                Text("Kein Host ist gerade erreichbar.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textMuted)
            } else {
                VStack(spacing: 12) {
                    ForEach(onlineHosts) { host in
                        HostCard(host: host)
                    }
                }
            }
        }
    }
}

private struct HostCard: View {
    let host: HostMetrics

    private let columns = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Circle()
                    .fill(Theme.statusGood)
                    .frame(width: 8, height: 8)
                Text(host.name)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                if !host.uptime.isEmpty {
                    Text(host.uptime)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                }
            }

            LazyVGrid(columns: columns, spacing: 8) {
                MetricTile(symbol: "cpu", label: "CPU", value: FormatterHelper.percentage(host.cpu), percentage: host.cpu)
                MetricTile(symbol: "memorychip", label: "RAM", value: FormatterHelper.percentage(host.ram), percentage: host.ram)
                MetricTile(symbol: "internaldrive", label: "Disk", value: FormatterHelper.percentage(host.disk), percentage: host.disk)
            }

            if host.temperature > 0 {
                HStack(spacing: 6) {
                    Image(systemName: "thermometer")
                        .foregroundStyle(StatusPalette.color(forPercentage: host.temperature))
                    Text(FormatterHelper.celsius(host.temperature))
                        .foregroundStyle(Theme.textMuted)
                }
                .font(.system(size: 13))
            }
        }
        .padding(12)
        .background(Theme.glassBackgroundStrong)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}

private struct MetricTile: View {
    let symbol: String
    let label: String
    let value: String
    let percentage: Double

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 14))
                .foregroundStyle(StatusPalette.color(forPercentage: percentage))
            Text(value)
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(Theme.textPrimary)
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}
