import SwiftUI

@main
struct CarPlayApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            DashboardViewController()
        }
    }
}
