import SwiftUI

/// Lets the user paste the bearer token generated in
/// docs/43-carplay-api.md ("Ersteinrichtung") into the Keychain.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var token: String = ""
    @State private var statusMessage: String?
    @State private var tankerkoenigKey: String = ""
    @State private var tankerkoenigStatusMessage: String?

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
                    Text("Erzeugt per kubeseal beim Einrichten von carplay-api — siehe docs/43-carplay-api.md \"Ersteinrichtung\" im capulus-core-Repo.")
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
}
