import SwiftUI

/// Middle column: fleet-wide system metrics from VictoriaMetrics.
struct MetricsGridView: View {
    let metrics: SystemMetrics

    private let columns = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        SectionCard(title: "Metrics") {
            LazyVGrid(columns: columns, spacing: 8) {
                MetricTile(symbol: "cpu", label: "CPU", value: FormatterHelper.percentage(metrics.cpu), percentage: metrics.cpu)
                MetricTile(symbol: "memorychip", label: "RAM", value: FormatterHelper.percentage(metrics.ram), percentage: metrics.ram)
                MetricTile(symbol: "internaldrive", label: "Disk", value: FormatterHelper.percentage(metrics.disk), percentage: metrics.disk)
                MetricTile(symbol: "thermometer", label: "Temp", value: FormatterHelper.celsius(metrics.temperature), percentage: metrics.temperature)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Uptime").foregroundColor(.secondary)
                    Spacer()
                    Text(metrics.uptime).fontWeight(.medium)
                }
                HStack {
                    Text("Load (1/5/15m)").foregroundColor(.secondary)
                    Spacer()
                    Text(metrics.loadAvg).fontWeight(.medium)
                }
            }
            .font(.system(size: 14))
            .padding(.top, 4)
        }
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
                .font(.system(size: 16))
                .foregroundColor(StatusPalette.color(forPercentage: percentage))
            Text(value)
                .font(.system(size: 24, weight: .bold))
            Text(label)
                .font(.system(size: 14))
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(8)
        .background(StatusPalette.color(forPercentage: percentage).opacity(0.12))
        .cornerRadius(8)
    }
}
