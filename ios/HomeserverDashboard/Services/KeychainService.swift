import Foundation
import Security

enum KeychainError: Error {
    case unhandled(OSStatus)
    case notFound
}

/// Stores the carplay-api bearer token in the iOS Keychain.
///
/// The original spec called for "Secure Enclave" storage — the Secure
/// Enclave protects private *keys* used for signing/decryption, it has no
/// API for storing an arbitrary opaque token like a bearer credential.
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is the correct primitive
/// here: device-encrypted, excluded from iCloud/iTunes backups, and
/// unreadable while the device is locked — the actual security property
/// the spec was after.
final class KeychainService {
    static let shared = KeychainService()
    private init() {}

    private let service = Constants.Keychain.service

    func saveToken(_ token: String) throws {
        try save(token, account: Constants.Keychain.tokenAccount)
    }

    func getToken() throws -> String {
        try get(account: Constants.Keychain.tokenAccount)
    }

    func deleteToken() {
        delete(account: Constants.Keychain.tokenAccount)
    }

    func saveTankerkoenigAPIKey(_ key: String) throws {
        try save(key, account: Constants.Keychain.tankerkoenigAPIKeyAccount)
    }

    func getTankerkoenigAPIKey() throws -> String {
        try get(account: Constants.Keychain.tankerkoenigAPIKeyAccount)
    }

    func deleteTankerkoenigAPIKey() {
        delete(account: Constants.Keychain.tankerkoenigAPIKeyAccount)
    }

    private func save(_ value: String, account: String) throws {
        let data = Data(value.utf8)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

        // Delete-then-add is simpler and just as correct as SecItemUpdate
        // for a single-value credential that's rewritten wholesale, not
        // partially updated.
        SecItemDelete(query as CFDictionary)

        var newItem = query
        newItem[kSecValueData as String] = data
        newItem[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly

        let status = SecItemAdd(newItem as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unhandled(status)
        }
    }

    private func get(account: String) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            if status == errSecItemNotFound {
                throw KeychainError.notFound
            }
            throw KeychainError.unhandled(status)
        }
        return value
    }

    private func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// Extension point for the future mTLS migration (see
    /// MTLSDelegate.swift) — returns the device's imported client identity
    /// once one has been provisioned via `SecPKCS12Import` and stored here.
    /// Not implemented: carplay-api doesn't require a client certificate
    /// today.
    func clientIdentity() -> SecIdentity? {
        nil
    }
}
