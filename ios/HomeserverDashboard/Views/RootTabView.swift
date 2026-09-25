import SwiftUI

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
        .navigationViewStyle(.stack)
    }

    private func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Theme.backgroundDark2)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
}

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
