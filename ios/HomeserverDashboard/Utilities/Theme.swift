import SwiftUI

/// Design tokens ported from github.com/pkr-lab/EDV-Kretzer (css/style.css
/// custom properties) so the app reads as the same brand as the website:
/// deep navy + red on a near-black gradient, glassmorphic cards. The app
/// forces dark mode everywhere (see HomeserverDashboardApp.swift) rather than adapting
/// to the system appearance — the site itself has no light variant to
/// match against.
enum Theme {
    // MARK: Brand colors (--color-* in style.css)
    static let primary = Color(hex: 0x0f3a5d)
    static let primaryLight = Color(hex: 0x1c5d8f)
    static let accent = Color(hex: 0xd32f2f)
    static let accentLight = Color(hex: 0xff5f52)
    static let backgroundDark = Color(hex: 0x0a0e27)
    static let backgroundDark2 = Color(hex: 0x0d1230)
    static let textPrimary = Color(hex: 0xe8ecf5)
    static let textMuted = Color(hex: 0xa9b3c9)

    // MARK: Glassmorphism (--glass-* in style.css)
    static let glassBackground = Color.white.opacity(0.06)
    static let glassBackgroundStrong = Color.white.opacity(0.10)
    static let glassBorder = Color.white.opacity(0.14)

    // MARK: Radius scale (--radius-* in style.css)
    static let radiusSmall: CGFloat = 8
    static let radiusMedium: CGFloat = 16
    static let radiusLarge: CGFloat = 24
    static let radiusPill: CGFloat = 999

    // MARK: Status colors (semantic, not brand — green/orange/red keep
    // their universal meaning for online/warning/offline regardless of
    // brand palette)
    static let statusGood = Color(hex: 0x34c759)
    static let statusWarning = Color(hex: 0xff9500)
    static let statusBad = Color(hex: 0xff3b30)

    static var backgroundGradient: LinearGradient {
        LinearGradient(colors: [backgroundDark, backgroundDark2], startPoint: .top, endPoint: .bottom)
    }

    static var accentGradient: LinearGradient {
        LinearGradient(colors: [primary, primaryLight], startPoint: .leading, endPoint: .trailing)
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

/// The glassmorphic card every screen is built from — blurred translucent
/// background, hairline border, generous corner radius, matching
/// EDV-Kretzer's --glass-* tokens.
struct GlassCard<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .background(.ultraThinMaterial)
            .background(Theme.glassBackground)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous)
                    .stroke(Theme.glassBorder, lineWidth: 1)
            )
    }
}

/// Titled section wrapper used across Home/Brightness/Power — same visual
/// language as the phone dashboard's previous SectionCard, now on glass.
struct SectionCard<Content: View>: View {
    let title: String
    var systemImage: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    if let systemImage {
                        Image(systemName: systemImage)
                            .foregroundStyle(Theme.accentLight)
                    }
                    Text(title)
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                }
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Screen-level scaffold: background gradient + scrollable glass content,
/// reused by every tab so the app reads as one consistent surface.
struct ScreenBackground<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            Theme.backgroundGradient.ignoresSafeArea()
            // Caps content at a phone-like column width so cards don't
            // stretch edge-to-edge on iPad — has no effect on iPhone,
            // where the screen is already narrower than the cap.
            content()
                .frame(maxWidth: 700)
                .frame(maxWidth: .infinity)
        }
    }
}
