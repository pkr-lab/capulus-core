import Foundation

/// Top-level app mode, switched via the picker in RootTabView and
/// persisted across launches. PKR-Lab is the original 3-tab lab dashboard
/// (Übersicht/Steuerung/Alerts, unchanged); Alltag swaps in weather,
/// Tankstellen and News instead.
enum DashboardMode: String {
    case pkrLab
    case alltag
}
