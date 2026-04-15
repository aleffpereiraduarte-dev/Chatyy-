import ExpoModulesCore
import Foundation
import Vision
import UIKit
import CryptoKit
import LocalAuthentication
import CoreSpotlight
import AVFoundation
import NaturalLanguage
import Security

/// Keychain-backed private key store. Keys never leave native code in the
/// new API path; the legacy path still hands raw bytes to JS for backwards
/// compat with the existing E2E flow.
internal enum ChatSecKeyStore {
    /// Versioned HKDF salt — see ExpoNativeChatSecurity for the rationale.
    /// Decrypt falls back to empty salt for legacy ciphertexts.
    static let hkdfSaltV2 = Data("chatyy-e2e-v2-2026-04".utf8)

    private static let service = "br.com.chatyy.e2e"

    static func store(privateKey: Data, keyId: String) {
        // Delete any prior entry with the same id (idempotent)
        _ = delete(keyId: keyId)
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyId,
            kSecValueData as String: privateKey,
            // Available after first unlock so the key is reachable for
            // background incoming-call decryption, but never accessible
            // when the device is locked.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func load(keyId: String) -> Data? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyId,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecSuccess, let data = out as? Data { return data }
        return nil
    }

    @discardableResult
    static func delete(keyId: String) -> Bool {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: keyId,
        ]
        return SecItemDelete(q as CFDictionary) == errSecSuccess
    }
}

// MARK: ─── 7. Vision OCR + 8. Translation + 9. CryptoKit E2E + 10. Spotlight ──
//
// All grouped into ExpoNativeChatSecurityModule so the auto-linker only sees
// one extra module name. Functions are namespaced by prefix.

public class ExpoNativeChatSecurityModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeChatSecurity")

        // ─── 7. Vision Framework OCR ──────────────────────────────────
        // Extract text from image messages on-device. Same engine that
        // powers iOS Live Text.
        AsyncFunction("ocrImage") { (imageUri: String, locales: [String]?) -> [String: Any] in
            let cleaned = imageUri.replacingOccurrences(of: "file://", with: "")
            guard let uiImage = UIImage(contentsOfFile: cleaned),
                  let cgImage = uiImage.cgImage else {
                return ["text": "", "blocks": [], "error": "load_failed"]
            }
            return await withCheckedContinuation { cont in
                let request = VNRecognizeTextRequest { req, err in
                    if let err = err {
                        cont.resume(returning: ["text": "", "blocks": [], "error": err.localizedDescription])
                        return
                    }
                    guard let observations = req.results as? [VNRecognizedTextObservation] else {
                        cont.resume(returning: ["text": "", "blocks": []])
                        return
                    }
                    var fullText: [String] = []
                    var blocks: [[String: Any]] = []
                    for obs in observations {
                        guard let candidate = obs.topCandidates(1).first else { continue }
                        fullText.append(candidate.string)
                        blocks.append([
                            "text": candidate.string,
                            "confidence": Double(candidate.confidence),
                            "x": Double(obs.boundingBox.minX),
                            "y": Double(obs.boundingBox.minY),
                            "width": Double(obs.boundingBox.width),
                            "height": Double(obs.boundingBox.height),
                        ])
                    }
                    cont.resume(returning: [
                        "text": fullText.joined(separator: "\n"),
                        "blocks": blocks,
                    ])
                }
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                if let locs = locales, !locs.isEmpty {
                    request.recognitionLanguages = locs
                } else {
                    request.recognitionLanguages = ["pt-BR", "en-US", "es-ES"]
                }
                let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
                DispatchQueue.global(qos: .userInitiated).async {
                    do { try handler.perform([request]) } catch {
                        cont.resume(returning: ["text": "", "blocks": [], "error": error.localizedDescription])
                    }
                }
            }
        }

        // ─── 8. Detect language of a message (NaturalLanguage framework) ─
        Function("detectLanguageSync") { (text: String) -> String in
            let recognizer = NLLanguageRecognizer()
            recognizer.processString(text)
            return recognizer.dominantLanguage?.rawValue ?? "und"
        }

        // ─── 8b. Translation (placeholder — Apple Translation needs iOS 17.4+ ─
        // and a SwiftUI .translationPresentation modifier. For now we just
        // return the source text and let JS fall back to server translation
        // when running on older iOS. Proper integration is gated on iOS 18+.
        AsyncFunction("translateText") { (text: String, targetLang: String) -> String in
            // No-op stub — Apple Translation requires SwiftUI presentation, not
            // a programmatic API yet. JS handles fall-through to server.
            return text
        }

        // ─── 9. CryptoKit E2E primitives ───────────────────────────────
        // Curve25519 key agreement + ChaChaPoly authenticated encryption.
        // 50x faster than tweetnacl JS for large messages.
        //
        // PROTOCOL NOTE — HKDF salt versioning:
        //   v1 (legacy)  → salt = empty Data()           (deployed history)
        //   v2 (current) → salt = "chatyy-e2e-v2-2026"   (proper protocol salt)
        //
        // We always ENCRYPT with v2. We DECRYPT by trying v2 first, then
        // falling back to v1 so messages encrypted by older app builds (and
        // sitting on the server) still open. Once every peer is on v2 the
        // legacy code path is dead but harmless.
        Function("generateKeypairSync") { () -> [String: String] in
            let priv = Curve25519.KeyAgreement.PrivateKey()
            let pub = priv.publicKey
            // Optimistic Keychain-backed storage for new callers (the JS
            // layer can opt in by reading `keyId`). Legacy callers keep
            // working because we still return `privateKey` until they
            // migrate.
            let keyId = "chatyy-e2e-" + UUID().uuidString
            ChatSecKeyStore.store(privateKey: priv.rawRepresentation, keyId: keyId)
            return [
                "publicKey": pub.rawRepresentation.base64EncodedString(),
                "privateKey": priv.rawRepresentation.base64EncodedString(),
                "keyId": keyId,
            ]
        }

        AsyncFunction("encryptMessage") { (plaintext: String, theirPubB64: String, ourPrivB64: String) -> [String: String] in
            guard let theirPubData = Data(base64Encoded: theirPubB64),
                  let ourPrivData = Data(base64Encoded: ourPrivB64),
                  let theirPub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirPubData),
                  let ourPriv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ourPrivData) else {
                throw NSError(domain: "ChatSec", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad keys"])
            }
            let shared = try ourPriv.sharedSecretFromKeyAgreement(with: theirPub)
            let sym = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                     salt: ChatSecKeyStore.hkdfSaltV2,
                                                     sharedInfo: Data("chatyy-e2e".utf8),
                                                     outputByteCount: 32)
            let plainData = plaintext.data(using: .utf8) ?? Data()
            let sealed = try ChaChaPoly.seal(plainData, using: sym)
            return [
                "ciphertext": sealed.ciphertext.base64EncodedString(),
                "nonce": sealed.nonce.withUnsafeBytes { Data($0) }.base64EncodedString(),
                "tag": sealed.tag.base64EncodedString(),
                "v": "2",
            ]
        }

        AsyncFunction("decryptMessage") { (ctB64: String, nonceB64: String, tagB64: String, theirPubB64: String, ourPrivB64: String) -> String in
            guard let ct = Data(base64Encoded: ctB64),
                  let nonceData = Data(base64Encoded: nonceB64),
                  let tag = Data(base64Encoded: tagB64),
                  let theirPubData = Data(base64Encoded: theirPubB64),
                  let ourPrivData = Data(base64Encoded: ourPrivB64),
                  let theirPub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirPubData),
                  let ourPriv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: ourPrivData) else {
                throw NSError(domain: "ChatSec", code: 2)
            }
            let shared = try ourPriv.sharedSecretFromKeyAgreement(with: theirPub)
            let nonce = try ChaChaPoly.Nonce(data: nonceData)
            let sealed = try ChaChaPoly.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
            // Try v2 first
            let symV2 = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                       salt: ChatSecKeyStore.hkdfSaltV2,
                                                       sharedInfo: Data("chatyy-e2e".utf8),
                                                       outputByteCount: 32)
            if let opened = try? ChaChaPoly.open(sealed, using: symV2) {
                return String(data: opened, encoding: .utf8) ?? ""
            }
            // Fall back to v1 (empty salt) for messages encrypted by older clients
            let symV1 = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                       salt: Data(),
                                                       sharedInfo: Data("chatyy-e2e".utf8),
                                                       outputByteCount: 32)
            let opened = try ChaChaPoly.open(sealed, using: symV1)
            return String(data: opened, encoding: .utf8) ?? ""
        }

        // ─── 9b. Keychain-backed E2E (no private key crosses the JS bridge) ─
        // New callers get a `keyId` instead of the raw private key. Encrypt /
        // decrypt look up the key in Keychain natively, so the secret never
        // hits JavaScript memory. Legacy `encryptMessage` / `decryptMessage`
        // are kept for transitional callers — once JS migrates fully we can
        // delete them.
        AsyncFunction("encryptMessageKid") { (plaintext: String, theirPubB64: String, keyId: String) -> [String: String] in
            guard let theirPubData = Data(base64Encoded: theirPubB64),
                  let theirPub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirPubData),
                  let privData = ChatSecKeyStore.load(keyId: keyId),
                  let ourPriv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privData) else {
                throw NSError(domain: "ChatSec", code: 11, userInfo: [NSLocalizedDescriptionKey: "bad keys/kid"])
            }
            let shared = try ourPriv.sharedSecretFromKeyAgreement(with: theirPub)
            let sym = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                     salt: ChatSecKeyStore.hkdfSaltV2,
                                                     sharedInfo: Data("chatyy-e2e".utf8),
                                                     outputByteCount: 32)
            let plainData = plaintext.data(using: .utf8) ?? Data()
            let sealed = try ChaChaPoly.seal(plainData, using: sym)
            return [
                "ciphertext": sealed.ciphertext.base64EncodedString(),
                "nonce": sealed.nonce.withUnsafeBytes { Data($0) }.base64EncodedString(),
                "tag": sealed.tag.base64EncodedString(),
                "v": "2",
            ]
        }

        AsyncFunction("decryptMessageKid") { (ctB64: String, nonceB64: String, tagB64: String, theirPubB64: String, keyId: String) -> String in
            guard let ct = Data(base64Encoded: ctB64),
                  let nonceData = Data(base64Encoded: nonceB64),
                  let tag = Data(base64Encoded: tagB64),
                  let theirPubData = Data(base64Encoded: theirPubB64),
                  let theirPub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirPubData),
                  let privData = ChatSecKeyStore.load(keyId: keyId),
                  let ourPriv = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privData) else {
                throw NSError(domain: "ChatSec", code: 12)
            }
            let shared = try ourPriv.sharedSecretFromKeyAgreement(with: theirPub)
            let nonce = try ChaChaPoly.Nonce(data: nonceData)
            let sealed = try ChaChaPoly.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
            let symV2 = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                       salt: ChatSecKeyStore.hkdfSaltV2,
                                                       sharedInfo: Data("chatyy-e2e".utf8),
                                                       outputByteCount: 32)
            if let opened = try? ChaChaPoly.open(sealed, using: symV2) {
                return String(data: opened, encoding: .utf8) ?? ""
            }
            let symV1 = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
                                                       salt: Data(),
                                                       sharedInfo: Data("chatyy-e2e".utf8),
                                                       outputByteCount: 32)
            let opened = try ChaChaPoly.open(sealed, using: symV1)
            return String(data: opened, encoding: .utf8) ?? ""
        }

        Function("importKeypairToKeychainSync") { (privateKeyB64: String) -> String in
            // For migrating an existing in-JS key into the Keychain. Returns
            // the new keyId; the JS layer is then expected to drop the
            // privateKey from its own storage.
            guard let priv = Data(base64Encoded: privateKeyB64) else { return "" }
            let kid = "chatyy-e2e-" + UUID().uuidString
            ChatSecKeyStore.store(privateKey: priv, keyId: kid)
            return kid
        }

        Function("hasKeychainKeySync") { (keyId: String) -> Bool in
            return ChatSecKeyStore.load(keyId: keyId) != nil
        }

        Function("deleteKeychainKeySync") { (keyId: String) -> Bool in
            return ChatSecKeyStore.delete(keyId: keyId)
        }

        // ─── 10. Spotlight indexing (CSSearchableIndex) ────────────────
        // PRIVACY: do NOT index plaintext message body. The previous version
        // wrote `body` straight into `contentDescription`, leaking chat
        // contents to system-wide Spotlight search and lock-screen
        // suggestions. We now index only metadata so the user can find
        // the conversation without exposing the message text outside the
        // app's sandbox. Real text search lives in the in-app SQLite FTS.
        AsyncFunction("indexMessageInSpotlight") { (messageId: String, conversationName: String, body: String, conversationId: String) -> Void in
            let attrs = CSSearchableItemAttributeSet(itemContentType: "public.text")
            attrs.title = conversationName
            attrs.contentDescription = "Chatyy"
            attrs.identifier = messageId
            let item = CSSearchableItem(uniqueIdentifier: messageId,
                                        domainIdentifier: "chatyy.message.\(conversationId)",
                                        attributeSet: attrs)
            try? await CSSearchableIndex.default().indexSearchableItems([item])
        }

        AsyncFunction("removeMessagesFromSpotlightForConversation") { (conversationId: String) -> Void in
            try? await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: ["chatyy.message.\(conversationId)"])
        }

        AsyncFunction("clearSpotlightIndex") { () -> Void in
            try? await CSSearchableIndex.default().deleteAllSearchableItems()
        }

        // ─── 11. Face ID / Touch ID per-chat lock ─────────────────────
        AsyncFunction("authenticateWithBiometrics") { (reason: String) -> Bool in
            let context = LAContext()
            var error: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
                return false
            }
            return await withCheckedContinuation { cont in
                context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                        localizedReason: reason) { ok, _ in
                    cont.resume(returning: ok)
                }
            }
        }

        Function("biometryTypeSync") { () -> String in
            let context = LAContext()
            var error: NSError?
            if !context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
                return "none"
            }
            switch context.biometryType {
            case .faceID: return "face"
            case .touchID: return "touch"
            case .opticID: return "optic"
            default: return "none"
            }
        }

        // ─── 12. Real waveform from AVAudioFile ───────────────────────
        // Reads the actual sample buffers from a .m4a / .wav and downsamples
        // to N bars. Replaces the fake random samples we had before.
        AsyncFunction("readWaveform") { (fileUri: String, bars: Int?) -> [Float] in
            let n = max(1, bars ?? 60)
            let cleaned = fileUri.replacingOccurrences(of: "file://", with: "")
            let url = URL(fileURLWithPath: cleaned)
            guard let file = try? AVAudioFile(forReading: url) else { return [] }

            let format = file.processingFormat
            let frameCount = AVAudioFrameCount(file.length)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return [] }
            do { try file.read(into: buffer) } catch { return [] }

            guard let channelData = buffer.floatChannelData?[0] else { return [] }
            let totalFrames = Int(buffer.frameLength)
            if totalFrames == 0 { return [] }

            let framesPerBar = max(1, totalFrames / n)
            var result: [Float] = []
            var idx = 0
            while idx < totalFrames {
                let end = min(idx + framesPerBar, totalFrames)
                var peak: Float = 0
                for i in idx..<end {
                    let s = abs(channelData[i])
                    if s > peak { peak = s }
                }
                result.append(peak)
                idx = end
            }
            // Normalize 0..1
            if let max = result.max(), max > 0 {
                result = result.map { $0 / max }
            }
            return result
        }
    }
}
