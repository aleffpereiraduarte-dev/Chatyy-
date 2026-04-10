import ExpoModulesCore
import Contacts

/// ExpoNativeContactsModule
/// High-performance native contacts reader using Apple's Contacts framework (CNContactStore).
/// Much faster and more reliable than the JS expo-contacts bridge.

public class ExpoNativeContactsModule: Module {
    private let store = CNContactStore()

    public func definition() -> ModuleDefinition {
        Name("ExpoNativeContacts")

        // ─── Synchronous: check current permission status ───────────
        Function("hasContactsPermission") { () -> Bool in
            let status = CNContactStore.authorizationStatus(for: .contacts)
            return status == .authorized
        }

        // ─── Async: request permission ──────────────────────────────
        AsyncFunction("requestContactsPermission") { () -> Bool in
            let status = CNContactStore.authorizationStatus(for: .contacts)

            switch status {
            case .authorized:
                return true
            case .denied, .restricted:
                return false
            case .notDetermined:
                return await withCheckedContinuation { cont in
                    self.store.requestAccess(for: .contacts) { granted, _ in
                        cont.resume(returning: granted)
                    }
                }
            @unknown default:
                return false
            }
        }

        // ─── Async: fetch all contacts ──────────────────────────────
        AsyncFunction("getAllContacts") { () -> [[String: Any]] in
            let status = CNContactStore.authorizationStatus(for: .contacts)
            guard status == .authorized else {
                return []
            }

            let keysToFetch: [CNKeyDescriptor] = [
                CNContactGivenNameKey as CNKeyDescriptor,
                CNContactFamilyNameKey as CNKeyDescriptor,
                CNContactEmailAddressesKey as CNKeyDescriptor,
                CNContactPhoneNumbersKey as CNKeyDescriptor,
            ]

            var results: [[String: Any]] = []

            let request = CNContactFetchRequest(keysToFetch: keysToFetch)
            request.sortOrder = .givenName

            do {
                try self.store.enumerateContacts(with: request) { contact, _ in
                    let emails = contact.emailAddresses.map { $0.value as String }
                    let phones = contact.phoneNumbers.map { $0.value.stringValue }

                    // Skip contacts with no email and no phone
                    guard !emails.isEmpty || !phones.isEmpty else { return }

                    let givenName = contact.givenName.trimmingCharacters(in: .whitespaces)
                    let familyName = contact.familyName.trimmingCharacters(in: .whitespaces)
                    let fullName: String
                    if !givenName.isEmpty && !familyName.isEmpty {
                        fullName = "\(givenName) \(familyName)"
                    } else if !givenName.isEmpty {
                        fullName = givenName
                    } else if !familyName.isEmpty {
                        fullName = familyName
                    } else {
                        fullName = "Unknown"
                    }

                    results.append([
                        "name": fullName,
                        "emails": emails,
                        "phones": phones,
                    ])
                }
            } catch {
                print("[ExpoNativeContacts] enumerate error: \(error.localizedDescription)")
                return []
            }

            return results
        }

        // ─── Async: quick contact count ─────────────────────────────
        AsyncFunction("getContactCount") { () -> Int in
            let status = CNContactStore.authorizationStatus(for: .contacts)
            guard status == .authorized else { return 0 }

            let keysToFetch: [CNKeyDescriptor] = [
                CNContactIdentifierKey as CNKeyDescriptor,
            ]

            var count = 0
            let request = CNContactFetchRequest(keysToFetch: keysToFetch)

            do {
                try self.store.enumerateContacts(with: request) { _, _ in
                    count += 1
                }
            } catch {
                print("[ExpoNativeContacts] count error: \(error.localizedDescription)")
            }

            return count
        }
    }
}
