import ExpoModulesCore
import Intents
import UIKit

// MARK: ─── ChatyyIntents — donate INSendMessageIntent so Chatyy contacts
// appear as suggestions in the iOS Share Sheet (the row of avatars on top).
// Each call to donate() teaches Siri "this user often sends to <person>".
// After ~30s of donations the system surfaces them in shareSheet rows; tapping
// one routes the share back to our ShareExtension with the intent prefilled.
//
// API (from JS):
//   ChatyyIntents.donateRecipient({
//     conversationId: '123',  // INPerson customIdentifier — used by share ext
//     name: 'Sara Zelle',     // INPerson displayName
//     email: 'sara@chatyy',   // INPersonHandle.value (used as routing key)
//     avatarUri: '/var/.../avatar.jpg',  // optional, file path or http(s)
//   })
//
//   ChatyyIntents.deleteAllDonations()  // for logout / privacy reset

public class ExpoChatyyIntentsModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoChatyyIntents")

        AsyncFunction("donateRecipient") { (
            args: [String: Any], promise: Promise
        ) in
            guard let convId = args["conversationId"] as? String, !convId.isEmpty,
                  let name = args["name"] as? String, !name.isEmpty,
                  let email = args["email"] as? String, !email.isEmpty else {
                promise.resolve(false)
                return
            }
            let avatarUri = args["avatarUri"] as? String

            // INImage from a local file or http(s) URL. We avoid blocking the
            // RN bridge by loading off the main thread when remote.
            DispatchQueue.global(qos: .utility).async {
                var avatar: INImage? = nil
                if let uri = avatarUri, !uri.isEmpty {
                    if uri.hasPrefix("http://") || uri.hasPrefix("https://") {
                        if let url = URL(string: uri),
                           let data = try? Data(contentsOf: url) {
                            avatar = INImage(imageData: data)
                        }
                    } else if FileManager.default.fileExists(atPath: uri) {
                        if let data = FileManager.default.contents(atPath: uri) {
                            avatar = INImage(imageData: data)
                        }
                    }
                }

                let handle = INPersonHandle(
                    value: email,
                    type: email.contains("@") ? .emailAddress : .unknown
                )
                let person = INPerson(
                    personHandle: handle,
                    nameComponents: nil,
                    displayName: name,
                    image: avatar,
                    contactIdentifier: convId,
                    customIdentifier: convId
                )

                let intent = INSendMessageIntent(
                    recipients: [person],
                    content: nil,
                    speakableGroupName: INSpeakableString(spokenPhrase: name),
                    conversationIdentifier: convId,
                    serviceName: "Chatyy",
                    sender: nil
                )
                if let avatar = avatar {
                    intent.setImage(avatar, forParameterNamed: \.speakableGroupName)
                }

                let interaction = INInteraction(intent: intent, response: nil)
                interaction.direction = .outgoing
                interaction.groupIdentifier = convId
                interaction.donate { error in
                    DispatchQueue.main.async {
                        if let error = error {
                            NSLog("[ChatyyIntents] donate err: \(error.localizedDescription)")
                            promise.resolve(false)
                        } else {
                            promise.resolve(true)
                        }
                    }
                }
            }
        }

        AsyncFunction("deleteAllDonations") { (promise: Promise) in
            INInteraction.deleteAll { error in
                if let error = error {
                    NSLog("[ChatyyIntents] deleteAll err: \(error.localizedDescription)")
                    promise.resolve(false)
                } else {
                    promise.resolve(true)
                }
            }
        }

        AsyncFunction("deleteByGroup") { (groupId: String, promise: Promise) in
            INInteraction.delete(with: groupId) { error in
                promise.resolve(error == nil)
            }
        }

        // MARK: ─── Share Extension data bridge ─────────────────────────────
        // The native ShareExtension UI (UIKit, no JS) needs the user's auth
        // token + a snapshot of their recent conversations to render the
        // contact list and post directly to the Chatyy API. We pass these
        // through the App Group's shared UserDefaults — both targets read/
        // write the same `group.com.onemundo.mail` suite, so no IPC needed.

        Function("setShareExtensionAuth") { (token: String, email: String, baseUrl: String) -> Bool in
            guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return false }
            ud.set(token, forKey: "chatyy.auth_token")
            ud.set(email, forKey: "chatyy.auth_email")
            ud.set(baseUrl, forKey: "chatyy.base_url")
            return true
        }

        Function("setShareExtensionConversations") { (conversations: [[String: Any]]) -> Bool in
            // conversations: array of { id, name, email, avatarUrl, type, lastMessageAt }
            guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return false }
            // Cap at 30 to keep the extension snappy + UserDefaults small.
            let trimmed = Array(conversations.prefix(30))
            if let data = try? JSONSerialization.data(withJSONObject: trimmed) {
                ud.set(data, forKey: "chatyy.recent_conversations")
                return true
            }
            return false
        }

        Function("clearShareExtensionData") { () -> Bool in
            guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return false }
            for key in ["chatyy.auth_token", "chatyy.auth_email", "chatyy.base_url",
                        "chatyy.recent_conversations"] {
                ud.removeObject(forKey: key)
            }
            return true
        }

        // WAVE 87 (2026-05-21): read the ShareExtension diagnostic
        // ring-buffer. The /share-diagnose screen in the host app
        // consumes this to surface exactly where the last share
        // session went wrong (auth missing, extract failed, HTTP 401,
        // iCloud timeout, etc.) — without this we have zero visibility
        // because iOS extensions can't reach Sentry/console/network
        // loggers reliably.
        Function("getShareExtensionDiag") { () -> [[String: Any]] in
            guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return [] }
            return (ud.array(forKey: "chatyy.share_diag") as? [[String: Any]]) ?? []
        }

        Function("getShareExtensionLastError") { () -> [String: Any]? in
            guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return nil }
            return ud.dictionary(forKey: "chatyy.share_last_error")
        }

        Function("clearShareExtensionDiag") { () -> Bool in
            guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return false }
            ud.removeObject(forKey: "chatyy.share_diag")
            ud.removeObject(forKey: "chatyy.share_last_error")
            return true
        }
    }
}
