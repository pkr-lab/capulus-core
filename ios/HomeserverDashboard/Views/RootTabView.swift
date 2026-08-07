import SwiftUI

/// The whole app: three tabs (overview + the two subpages the spec asked
/// for), no CarPlay scene — this is a pure iPhone app now.
struct RootTabView: View {
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Übersicht", systemImage: "square.grid.2x2.fill") }

            BrightnessView()
                .tabItem { Label("Helligkeit", systemImage: "sun.max.fill") }

            PowerView()
                .tabItem { Label("Steuerung", systemImage: "power") }
        }
        .tint(Theme.accentLight)
        .preferredColorScheme(.dark)
        .onAppear(perform: configureTabBarAppearance)
    }

    /// Without this, UITabBar falls back to the system's translucent
    /// light-leaning material even under forced dark mode, which clashes
    /// with the near-black brand background.
    private func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Theme.backgroundDark2)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
}
