import SwiftUI

/// The whole app, in one of two modes picked at the top and persisted
/// across launches (see DashboardMode):
/// - PKR-Lab: the original 3 tabs — overview, control (brightness +
///   wake/shutdown), alerts. Unchanged.
/// - Alltag: weather dashboard, Tankstellen, News.
/// No CarPlay scene — universal iPhone/iPad app, no Mac.
struct RootTabView: View {
    @AppStorage("dashboardMode") private var modeRaw = DashboardMode.pkrLab.rawValue

    private var mode: DashboardMode {
        DashboardMode(rawValue: modeRaw) ?? .pkrLab
    }

    var body: some View {
        VStack(spacing: 0) {
            ModeSwitcher(mode: Binding(
                get: { mode },
                set: { modeRaw = $0.rawValue }
            ))

            TabView {
                switch mode {
                case .pkrLab:
                    HomeView()
                        .tabItem { Label("Übersicht", systemImage: "square.grid.2x2.fill") }

                    PowerView()
                        .tabItem { Label("Steuerung", systemImage: "power") }

                    AlertsView()
                        .tabItem { Label("Alerts", systemImage: "bell.fill") }

                case .alltag:
                    AlltagDashboardView()
                        .tabItem { Label("Dashboard", systemImage: "square.grid.2x2.fill") }

                    TankstellenView()
                        .tabItem { Label("Tankstellen", systemImage: "fuelpump.fill") }

                    NewsView()
                        .tabItem { Label("News", systemImage: "newspaper.fill") }
                }
            }
        }
        .background(Theme.backgroundDark2.ignoresSafeArea(edges: .top))
        .tint(Theme.accentLight)
        .preferredColorScheme(.dark)
        .onAppear(perform: configureTabBarAppearance)
        // Every tab's root is a single-screen NavigationView, not a
        // master/detail pair — without .stack, iPad defaults to a
        // two-column split (narrow sidebar + empty black detail pane).
        // Style propagates down to all nested NavigationViews.
        .navigationViewStyle(.stack)
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

/// The PKR-Lab/Alltag switch pinned above the tab content, always visible
/// and reachable regardless of which tab is currently open — switching
/// modes changes the whole tab set, not just one screen's content.
private struct ModeSwitcher: View {
    @Binding var mode: DashboardMode

    var body: some View {
        Picker("Modus", selection: $mode) {
            Text("PKR-Lab").tag(DashboardMode.pkrLab)
            Text("Alltag").tag(DashboardMode.alltag)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }
}
