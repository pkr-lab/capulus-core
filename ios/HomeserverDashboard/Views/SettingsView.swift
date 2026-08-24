import SwiftUI

/// Lets the user paste the bearer token generated in
/// docs/3-apps-workloads/300d0-carplay-api.md ("Ersteinrichtung") into the Keychain.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var token: String = ""
    @State private var statusMessage: String?
    @State private var tankerkoenigKey: String = ""
    @State private var tankerkoenigStatusMessage: String?
    @State private var wolAgentToken: String = ""
    @State private var wolAgentStatusMessage: String?

    var body: some View {
        NavigationView {
            Form {
                Section {
                    SecureField("Bearer token", text: $token)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true) // .autocorrectionDisabled() needs iOS 16; target here is 15.0
                } header: {
                    Text("carplay-api Token")
                } footer: {
                    Text("Erzeugt per kubeseal beim Einrichten von carplay-api — siehe docs/3-apps-workloads/300d0-carplay-api.md \"Ersteinrichtung\" im capulus-core-Repo.")
                }

                Section {
                    Button("In Keychain speichern") { save() }
                        .disabled(token.isEmpty)
                    Button("Gespeichertes Token entfernen", role: .destructive) { remove() }
                }

                if let statusMessage {
                    Section {
                        Text(statusMessage)
                            .foregroundColor(.secondary)
                    }
                }

                Section {
                    SecureField("API-Key", text: $tankerkoenigKey)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                } header: {
                    Text("Tankerkönig API-Key")
                } footer: {
                    Text("Für die Tankstellen-Seite im Alltag-Modus. Kostenlosen Key registrieren: creativecommons.tankerkoenig.de")
                }

                Section {
                    Button("In Keychain speichern") { saveTankerkoenigKey() }
                        .disabled(tankerkoenigKey.isEmpty)
                    Button("Gespeicherten Key entfernen", role: .destructive) { removeTankerkoenigKey() }
                }

                if let tankerkoenigStatusMessage {
                    Section {
                        Text(tankerkoenigStatusMessage)
                            .foregroundColor(.secondary)
                    }
                }

                Section {
                    SecureField("Bearer token", text: $wolAgentToken)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                } header: {
                    Text("Vereinsheim-WoL-Agent-Token")
                } footer: {
                    Text("Auf dem Pi selbst erzeugt (docs/3-apps-workloads/30020-vereinsheim-alarmmonitor.md im capulus-core-Repo, Abschnitt \"Wake-on-LAN für den Windows-PC\") — auslesen mit: ssh pela@vereinsheim-alarmmonitor sudo cat /etc/banana-pi-wol-agent/token")
                }

                Section {
                    Button("In Keychain speichern") { saveWolAgentToken() }
                        .disabled(wolAgentToken.isEmpty)
                    Button("Gespeichertes Token entfernen", role: .destructive) { removeWolAgentToken() }
                }

                if let wolAgentStatusMessage {
                    Section {
                        Text(wolAgentStatusMessage)
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Einstellungen")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
            .onAppear {
                if (try? KeychainService.shared.getToken()) != nil {
                    statusMessage = "Es ist bereits ein Token gespeichert."
                }
                if (try? KeychainService.shared.getTankerkoenigAPIKey()) != nil {
                    tankerkoenigStatusMessage = "Es ist bereits ein Key gespeichert."
                }
                if (try? KeychainService.shared.getWolAgentToken()) != nil {
                    wolAgentStatusMessage = "Es ist bereits ein Token gespeichert."
                }
            }
        }
    }

    private func save() {
        do {
            try KeychainService.shared.saveToken(token)
            statusMessage = "Token gespeichert."
            token = ""
        } catch {
            statusMessage = "Speichern fehlgeschlagen: \(error.localizedDescription)"
        }
    }

    private func remove() {
        KeychainService.shared.deleteToken()
        statusMessage = "Token entfernt."
    }

    private func saveTankerkoenigKey() {
        do {
            try KeychainService.shared.saveTankerkoenigAPIKey(tankerkoenigKey)
            tankerkoenigStatusMessage = "Key gespeichert."
            tankerkoenigKey = ""
        } catch {
            tankerkoenigStatusMessage = "Speichern fehlgeschlagen: \(error.localizedDescription)"
        }
    }

    private func removeTankerkoenigKey() {
        KeychainService.shared.deleteTankerkoenigAPIKey()
        tankerkoenigStatusMessage = "Key entfernt."
    }

    private func saveWolAgentToken() {
        do {
            try KeychainService.shared.saveWolAgentToken(wolAgentToken)
            wolAgentStatusMessage = "Token gespeichert."
            wolAgentToken = ""
        } catch {
            wolAgentStatusMessage = "Speichern fehlgeschlagen: \(error.localizedDescription)"
        }
    }

    private func removeWolAgentToken() {
        KeychainService.shared.deleteWolAgentToken()
        wolAgentStatusMessage = "Token entfernt."
    }
}
