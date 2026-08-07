import SwiftUI

/// Lets the user paste the bearer token generated in
/// docs/43-carplay-api.md ("Ersteinrichtung") into the Keychain.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var token: String = ""
    @State private var statusMessage: String?

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
}
