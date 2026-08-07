import SwiftUI

/// Subpage 1: controls the Homeserver's own screen brightness (HP ProBook
/// 450 G9, see docs/01-overview.md) via the intel_backlight sysfs device —
/// proxied through carplay-api to power-agent on the host, since the
/// carplay-api pod itself has no sysfs access.
struct BrightnessView: View {
    @ObservedObject private var viewModel = PowerViewModel.shared
    @State private var sliderValue: Double = 50
    @State private var isEditing = false
    @State private var showingSettings = false

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(spacing: 16) {
                        SectionCard(title: "Bildschirmhelligkeit", systemImage: "sun.max.fill") {
                            VStack(spacing: 18) {
                                if viewModel.isLoadingBrightness && viewModel.brightness == nil {
                                    ProgressView()
                                        .tint(Theme.textPrimary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 28)
                                } else {
                                    VStack(spacing: 14) {
                                        Text("\(Int(sliderValue))%")
                                            .font(.system(size: 44, weight: .bold, design: .rounded))
                                            .foregroundStyle(Theme.textPrimary)

                                        HStack(spacing: 12) {
                                            Image(systemName: "sun.min")
                                                .foregroundStyle(Theme.textMuted)
                                            Slider(
                                                value: $sliderValue,
                                                in: 1...100,
                                                step: 1,
                                                onEditingChanged: handleEditingChanged
                                            )
                                            .tint(Theme.accentLight)
                                            Image(systemName: "sun.max")
                                                .foregroundStyle(Theme.textMuted)
                                        }
                                    }
                                }

                                if let error = viewModel.brightnessError {
                                    Text(error)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.statusBad)
                                }

                                Text("Steuert den eingebauten Bildschirm des Homeservers (HP ProBook 450 G9).")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.textMuted)
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Helligkeit")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .task {
                await viewModel.loadBrightness()
                if let brightness = viewModel.brightness {
                    sliderValue = Double(brightness)
                }
            }
            .onChange(of: viewModel.brightness) { newValue in
                guard !isEditing, let newValue else { return }
                sliderValue = Double(newValue)
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
        }
    }

    /// Applies the new value once the finger lifts, not on every frame the
    /// slider moves — brightness writes hit sysfs on the homeserver host
    /// through two network hops (this app -> carplay-api -> power-agent),
    /// so streaming every intermediate value would just queue up stale
    /// writes behind the current one.
    private func handleEditingChanged(_ editing: Bool) {
        isEditing = editing
        guard !editing else { return }
        Task { await viewModel.setBrightness(percent: Int(sliderValue)) }
    }
}
