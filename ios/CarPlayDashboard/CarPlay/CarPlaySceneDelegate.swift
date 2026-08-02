import CarPlay
import UIKit

/// Root of the CarPlay experience. Holds the CPInterfaceController for the
/// lifetime of the CarPlay connection and keeps its CPTabBarTemplate's
/// three lists (see DashboardTemplateBuilder) in sync with
/// DashboardViewModel's 30s refresh.
class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var alertsTemplate: CPListTemplate?
    private var metricsTemplate: CPListTemplate?
    private var statusTemplate: CPListTemplate?

    private var notificationTokens: [NSObjectProtocol] = []

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController

        let dashboard = DashboardViewModel.shared.dashboard
        let alerts = alertsTemplate ?? DashboardTemplateBuilder.alertsTemplate(for: dashboard?.alerts ?? [])
        let metrics = metricsTemplate ?? DashboardTemplateBuilder.metricsTemplate(for: dashboard?.metrics ?? .placeholder)
        let status = statusTemplate ?? DashboardTemplateBuilder.statusTemplate(for: dashboard?.status ?? [])
        alertsTemplate = alerts
        metricsTemplate = metrics
        statusTemplate = status

        let tabBar = CPTabBarTemplate(templates: [alerts, metrics, status])
        interfaceController.setRootTemplate(tabBar, animated: false, completion: nil)

        DashboardViewModel.shared.onUpdate = { [weak self] dashboard in
            self?.update(with: dashboard)
        }
        registerDetailHandlers()

        Task { @MainActor in
            DashboardViewModel.shared.startAutoRefresh()
        }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        self.interfaceController = nil
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
        notificationTokens.removeAll()
        // Deliberately not stopping DashboardViewModel's refresh loop here —
        // the phone companion UI may still be visible and relying on it.
    }

    @MainActor
    private func update(with dashboard: CarPlayDashboard) {
        alertsTemplate?.updateSections(DashboardTemplateBuilder.alertSections(dashboard.alerts))
        metricsTemplate?.updateSections(DashboardTemplateBuilder.metricsSections(dashboard.metrics))
        statusTemplate?.updateSections(DashboardTemplateBuilder.statusSections(dashboard.status))
    }

    private func registerDetailHandlers() {
        let alertToken = NotificationCenter.default.addObserver(
            forName: .carPlayDidSelectAlert, object: nil, queue: .main
        ) { [weak self] notification in
            guard let alert = notification.object as? Alert else { return }
            self?.pushAlertDetail(alert)
        }
        let statusToken = NotificationCenter.default.addObserver(
            forName: .carPlayDidSelectService, object: nil, queue: .main
        ) { [weak self] notification in
            guard let status = notification.object as? ServiceStatus else { return }
            self?.pushServiceDetail(status)
        }
        notificationTokens = [alertToken, statusToken]
    }

    private func pushAlertDetail(_ alert: Alert) {
        let items = [
            CPInformationItem(title: "Topic", detail: alert.topic),
            CPInformationItem(title: "Message", detail: alert.message),
            CPInformationItem(title: "Received", detail: FormatterHelper.relativeTime(alert.time)),
            CPInformationItem(title: "Level", detail: alert.level.rawValue.capitalized),
        ]
        let template = CPInformationTemplate(
            title: alert.title,
            layout: .leading,
            items: items,
            actions: []
        )
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }

    private func pushServiceDetail(_ status: ServiceStatus) {
        let items = [
            CPInformationItem(title: "Status", detail: status.status.rawValue.capitalized),
            CPInformationItem(title: "Ping", detail: FormatterHelper.ping(status.ping)),
            CPInformationItem(title: "Uptime (24h)", detail: FormatterHelper.uptimePercentage(status.uptime)),
            CPInformationItem(title: "Last check", detail: FormatterHelper.relativeTime(status.lastCheck)),
        ]
        let template = CPInformationTemplate(
            title: status.name,
            layout: .leading,
            items: items,
            actions: []
        )
        interfaceController?.pushTemplate(template, animated: true, completion: nil)
    }
}
