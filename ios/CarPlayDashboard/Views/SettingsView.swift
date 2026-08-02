import SwiftUI

/// Lets the user paste the bearer token generated in
/// docs/43-carplay-api.md ("Ersteinrichtung") into the Keychain. Not part
/// of the original file list, but the API client is useless without
/// somewhere to put the token — see ios/README.md "Ersteinrichtung".
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
                    Text("carplay-api token")
                } footer: {
                    Text("Generated via kubeseal when carplay-api was set up — see docs/43-carplay-api.md \"Ersteinrichtung\" in the capulus-core repo.")
                }

                Section {
                    Button("Save to Keychain") { save() }
                        .disabled(token.isEmpty)
                    Button("Remove stored token", role: .destructive) { remove() }
                }

                if let statusMessage {
                    Section {
                        Text(statusMessage)
                            .foregroundColor(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                if (try? KeychainService.shared.getToken()) != nil {
                    statusMessage = "A token is currently stored."
                }
            }
        }
    }

    private func save() {
        do {
            try KeychainService.shared.saveToken(token)
            statusMessage = "Token saved."
            token = ""
        } catch {
            statusMessage = "Failed to save: \(error.localizedDescription)"
        }
    }

    private func remove() {
        KeychainService.shared.deleteToken()
        statusMessage = "Token removed."
    }
}
