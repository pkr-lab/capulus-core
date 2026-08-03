import CarPlay
import UIKit

/// Bridges the SwiftUI app lifecycle (`CarPlayApp`) to UIKit's scene
/// configuration lookup — needed because SwiftUI's `App`/`Scene` API alone
/// has no way to hand back a *different* scene delegate for the CarPlay
/// connection role. This is the standard, Apple-documented pattern for
/// mixing SwiftUI apps with CarPlay (see WWDC "Bring your Own UI to
/// CarPlay").
class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        if connectingSceneSession.role == .carTemplateApplication {
            let config = UISceneConfiguration(name: "CarPlay", sessionRole: connectingSceneSession.role)
            config.delegateClass = CarPlaySceneDelegate.self
            return config
        }

        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}
