import CarPlay
import UIKit

/// Builds and refreshes the three CPListTemplates that make up the
/// dashboard.
///
/// The spec describes a simultaneous 3-column grid. CarPlay's template API
/// has no such primitive for rich, dynamic list content — `CPListTemplate`
/// is a single scrollable column, `CPGridTemplate` is capped at ~8 static
/// icon+title buttons with no subtitle/detail text (fine for launching
/// actions, not for showing alert text or ping times). A `CPTabBarTemplate`
/// with one list per column, switched by tab, is the closest thing CarPlay
/// actually offers to "three columns" — the tabs stand in for columns the
/// driver switches between instead of viewing side by side.
enum DashboardTemplateBuilder {
    static func alertsTemplate(for alerts: [Alert]) -> CPListTemplate {
        let template = CPListTemplate(title: "Alerts", sections: alertSections(alerts))
        template.tabTitle = "Alerts"
        template.tabImage = UIImage(systemName: "bell.fill")
        return template
    }

    static func metricsTemplate(for metrics: SystemMetrics) -> CPListTemplate {
        let template = CPListTemplate(title: "Metrics", sections: metricsSections(metrics))
        template.tabTitle = "Metrics"
        template.tabImage = UIImage(systemName: "gauge.with.dots.needle.50percent")
        return template
    }

    static func statusTemplate(for statuses: [ServiceStatus]) -> CPListTemplate {
        let template = CPListTemplate(title: "Status", sections: statusSections(statuses))
        template.tabTitle = "Status"
        template.tabImage = UIImage(systemName: "checkmark.shield.fill")
        return template
    }

    // MARK: - Sections

    static func alertSections(_ alerts: [Alert]) -> [CPListSection] {
        if alerts.isEmpty {
            let empty = CPListItem(text: "No active alerts", detailText: nil)
            empty.isEnabled = false
            return [CPListSection(items: [empty])]
        }

        let items = alerts.map { alert -> CPListItem in
            let item = CPListItem(
                text: FormatterHelper.truncate(alert.title, maxLength: Constants.maxAlertTitleLength),
                detailText: FormatterHelper.truncate(alert.message, maxLength: Constants.maxAlertSubtitleLength),
                image: StatusPalette.tintedImage(
                    systemName: StatusPalette.sfSymbol(for: alert.level),
                    tint: StatusPalette.uiColor(for: alert.level)
                )
            )
            item.handler = { _, completion in
                NotificationCenter.default.post(name: .carPlayDidSelectAlert, object: alert)
                completion()
            }
            return item
        }
        return [CPListSection(items: items)]
    }

    static func metricsSections(_ metrics: SystemMetrics) -> [CPListSection] {
        func gauge(_ title: String, symbol: String, value: Double, formatted: String) -> CPListItem {
            CPListItem(
                text: title,
                detailText: formatted,
                image: StatusPalette.tintedImage(systemName: symbol, tint: StatusPalette.uiColor(forPercentage: value))
            )
        }

        let gauges = CPListSection(items: [
            gauge("CPU", symbol: "cpu", value: metrics.cpu, formatted: FormatterHelper.percentage(metrics.cpu)),
            gauge("RAM", symbol: "memorychip", value: metrics.ram, formatted: FormatterHelper.percentage(metrics.ram)),
            gauge("Disk", symbol: "internaldrive", value: metrics.disk, formatted: FormatterHelper.percentage(metrics.disk)),
            gauge("Temp", symbol: "thermometer", value: metrics.temperature, formatted: FormatterHelper.celsius(metrics.temperature)),
        ], header: "Fleet Average", sectionIndexTitle: nil)

        let uptimeItem = CPListItem(text: "Uptime", detailText: metrics.uptime, image: UIImage(systemName: "clock.fill"))
        let loadItem = CPListItem(text: "Load Avg (1/5/15m)", detailText: metrics.loadAvg, image: UIImage(systemName: "waveform.path.ecg"))
        let info = CPListSection(items: [uptimeItem, loadItem])

        return [gauges, info]
    }

    static func statusSections(_ statuses: [ServiceStatus]) -> [CPListSection] {
        if statuses.isEmpty {
            let empty = CPListItem(text: "No monitors configured", detailText: nil)
            empty.isEnabled = false
            return [CPListSection(items: [empty])]
        }

        let items = statuses.map { status -> CPListItem in
            let detail: String
            switch status.status {
            case .up:
                detail = "UP · \(FormatterHelper.ping(status.ping)) · \(FormatterHelper.uptimePercentage(status.uptime))"
            case .down:
                detail = "DOWN"
            case .maintenance:
                detail = "MAINTENANCE"
            case .paused:
                detail = "PAUSED"
            }

            let item = CPListItem(
                text: status.name,
                detailText: detail,
                image: StatusPalette.tintedImage(
                    systemName: StatusPalette.sfSymbol(for: status.status),
                    tint: StatusPalette.uiColor(for: status.status)
                )
            )
            item.handler = { _, completion in
                NotificationCenter.default.post(name: .carPlayDidSelectService, object: status)
                completion()
            }
            return item
        }
        return [CPListSection(items: items)]
    }
}

extension Notification.Name {
    static let carPlayDidSelectAlert = Notification.Name("carPlayDidSelectAlert")
    static let carPlayDidSelectService = Notification.Name("carPlayDidSelectService")
}
