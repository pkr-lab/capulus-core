import Foundation
import Security

enum KeychainError: Error {
    case unhandled(OSStatus)
    case notFound
}

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

    func saveWolAgentToken(_ token: String) throws {
        try save(token, account: Constants.Keychain.wolAgentTokenAccount)
    }

    func getWolAgentToken() throws -> String {
        try get(account: Constants.Keychain.wolAgentTokenAccount)
    }

    func deleteWolAgentToken() {
        delete(account: Constants.Keychain.wolAgentTokenAccount)
    }

    private func save(_ value: String, account: String) throws {
        let data = Data(value.utf8)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]

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

    func clientIdentity() -> SecIdentity? {
        nil
    }
}
