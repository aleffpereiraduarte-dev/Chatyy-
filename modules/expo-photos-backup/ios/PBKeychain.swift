import Foundation
import Security

// [2026-10-15 photos-native] Token do backup no Keychain (não em UserDefaults
// como o módulo antigo). AfterFirstUnlockThisDeviceOnly: legível pelo
// BGProcessingTask com o aparelho bloqueado, nunca vai p/ backup/outro aparelho.
enum PBKeychain {
  private static let service = "br.com.chatyy.photosbackup"

  static func set(_ value: String, account: String) {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)
    if value.isEmpty { return }
    var add = base
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }

  static func get(account: String) -> String? {
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    let s = String(data: d, encoding: .utf8)
    return (s?.isEmpty ?? true) ? nil : s
  }

  static func delete(account: String) { set("", account: account) }
}
