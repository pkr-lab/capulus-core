import SwiftUI

/// Subpage 2: Wake-on-LAN + shutdown for worker-0/worker-1, and shutdown
/// (only — the Homeserver has no WoL path, it's the always-on control
/// plane, see docs/37-cluster-power-manager.md) for the Homeserver itself,
/// gated behind an extra warning + the same confirmation code as ArgoCD.
struct PowerView: View {
    @ObservedObject private var dashboardViewModel = DashboardViewModel.shared
    @ObservedObject private var powerViewModel = PowerViewModel.shared
    @State private var showingSettings = false
    @State private var confirmingShutdown: PowerTarget?
    @State private var showingHomeserverWarning = false

    private func host(_ id: String) -> HostMetrics? {
        dashboardViewModel.dashboard?.hosts.first { $0.id == id }
    }

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(spacing: 16) {
                        PowerTargetCard(
                            target: .worker0,
                            isOnline: host("worker-0")?.online ?? false,
                            isBusy: powerViewModel.pendingAction == .worker0,
                            onWake: { Task { await powerViewModel.wake(.worker0) } },
                            onShutdown: { confirmingShutdown = .worker0 }
                        )
                        PowerTargetCard(
                            target: .worker1,
                            isOnline: host("worker-1")?.online ?? false,
                            isBusy: powerViewModel.pendingAction == .worker1,
                            onWake: { Task { await powerViewModel.wake(.worker1) } },
                            onShutdown: { confirmingShutdown = .worker1 }
                        )
                        HomeserverPowerCard(
                            isOnline: host("homeserver")?.online ?? true,
                            isBusy: powerViewModel.pendingAction == .homeserver,
                            onShutdown: { showingHomeserverWarning = true }
                        )

                        if let error = powerViewModel.actionError {
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.statusBad)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Steuerung")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsView()
            }
            .confirmationDialog(
                confirmingShutdown.map { "\($0.displayName) wirklich herunterfahren?" } ?? "",
                isPresented: Binding(
                    get: { confirmingShutdown != nil },
                    set: { if !$0 { confirmingShutdown = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Herunterfahren", role: .destructive) {
                    if let target = confirmingShutdown {
                        Task { await powerViewModel.shutdown(target) }
                    }
                    confirmingShutdown = nil
                }
                Button("Abbrechen", role: .cancel) {
                    confirmingShutdown = nil
                }
            }
            .sheet(isPresented: $showingHomeserverWarning) {
                HomeserverShutdownSheet(
                    isBusy: powerViewModel.pendingAction == .homeserver,
                    onConfirm: { code in
                        Task {
                            await powerViewModel.shutdown(.homeserver, code: code)
                            if powerViewModel.actionError == nil {
                                showingHomeserverWarning = false
                            }
                        }
                    },
                    onCancel: { showingHomeserverWarning = false },
                    error: powerViewModel.actionError
                )
            }
        }
    }
}

private struct PowerTargetCard: View {
    let target: PowerTarget
    let isOnline: Bool
    let isBusy: Bool
    let onWake: () -> Void
    let onShutdown: () -> Void

    var body: some View {
        SectionCard(title: target.displayName, systemImage: "desktopcomputer") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(isOnline ? Theme.statusGood : Theme.textMuted)
                        .frame(width: 8, height: 8)
                    Text(isOnline ? "Online" : "Offline")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                    Spacer()
                    if isBusy {
                        ProgressView().tint(Theme.textPrimary)
                    }
                }

                HStack(spacing: 12) {
                    Button(action: onWake) {
                        Label("Aufwecken", systemImage: "bolt.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PowerButtonStyle(kind: .primary))
                    .disabled(isOnline || isBusy)

                    Button(action: onShutdown) {
                        Label("Ausschalten", systemImage: "power")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PowerButtonStyle(kind: .destructive))
                    .disabled(!isOnline || isBusy)
                }
            }
        }
    }
}

private struct HomeserverPowerCard: View {
    let isOnline: Bool
    let isBusy: Bool
    let onShutdown: () -> Void

    var body: some View {
        SectionCard(title: "Homeserver", systemImage: "server.rack") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(isOnline ? Theme.statusGood : Theme.statusBad)
                        .frame(width: 8, height: 8)
                    Text(isOnline ? "Online" : "Nicht erreichbar")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textMuted)
                    Spacer()
                    if isBusy {
                        ProgressView().tint(Theme.textPrimary)
                    }
                }

                Text("Kein Wake-on-LAN möglich — der Homeserver ist der einzige Dauerläufer im Cluster (siehe docs/01-overview.md).")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textMuted)

                Button(action: onShutdown) {
                    Label("Homeserver herunterfahren", systemImage: "exclamationmark.triangle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PowerButtonStyle(kind: .destructive))
                .disabled(isBusy)
            }
        }
    }
}

private struct PowerButtonStyle: ButtonStyle {
    enum Kind { case primary, destructive }
    let kind: Kind
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.vertical, 10)
            .background(background)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)
    }

    private var background: LinearGradient {
        switch kind {
        case .primary:
            return Theme.accentGradient
        case .destructive:
            return LinearGradient(colors: [Theme.accent, Theme.accentLight], startPoint: .leading, endPoint: .trailing)
        }
    }
}

/// The extra warning + code prompt gating a Homeserver shutdown — the code
/// is the same one used for the ArgoCD admin login (see
/// docs/43-carplay-api.md), checked server-side against
/// SHUTDOWN_CONFIRMATION_CODE. The app never stores or pre-fills it.
private struct HomeserverShutdownSheet: View {
    let isBusy: Bool
    let onConfirm: (String) -> Void
    let onCancel: () -> Void
    let error: String?

    @State private var code = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            ScreenBackground {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 32))
                                .foregroundStyle(Theme.statusBad)
                            Text("Achtung")
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(Theme.textPrimary)
                            Text("Das schaltet den gesamten Homeserver aus — damit auch Kubernetes, ArgoCD, diese API und alle darauf laufenden Dienste. Ein Wiedereinschalten ist nur vor Ort möglich, es gibt keinen Wake-on-LAN-Weg für den Homeserver.")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.textMuted)
                        }

                        SectionCard(title: "Bestätigungscode") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Derselbe Code wie für den ArgoCD-Admin-Login.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.textMuted)
                                SecureField("Code", text: $code)
                                    .textInputAutocapitalization(.never)
                                    .disableAutocorrection(true)
                                    .padding(10)
                                    .background(Theme.glassBackgroundStrong)
                                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
                                    .foregroundStyle(Theme.textPrimary)

                                if let error {
                                    Text(error)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.statusBad)
                                }
                            }
                        }

                        Button {
                            onConfirm(code)
                        } label: {
                            HStack {
                                if isBusy {
                                    ProgressView().tint(.white)
                                }
                                Text("Homeserver jetzt herunterfahren")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PowerButtonStyle(kind: .destructive))
                        .disabled(code.isEmpty || isBusy)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Homeserver herunterfahren")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Abbrechen") {
                        onCancel()
                        dismiss()
                    }
                }
            }
        }
    }
}
