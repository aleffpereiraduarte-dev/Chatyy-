//
//  ChatyyE2EEModule.swift — E2EE v4 nativo (iOS).
//
//  Fina camada Expo por cima do vodozemac (Rust, via UniFFI →
//  Generated/ChatyyE2EECore.swift + ChatyyE2EECore.xcframework). NENHUMA
//  criptografia aqui: só guarda os objetos Rust num mapa de handles (Int) para
//  o JS (services/e2eeV4Native.js) montar classes com a MESMA forma do wasm
//  usado no web (OlmAccount/OlmSession/ed25519Verify/preKeySessionId).
//
//  Funções SÍNCRONAS de propósito: o núcleo JS (services/e2eeV4Core.js) usa a
//  API síncrona do wasm; uma operação de ratchet custa microssegundos.
//  Bytes (pickle key) passam como base64 (sem depender de TypedArray no bridge).
//

import ExpoModulesCore
import Foundation
import Security
import CryptoKit

private final class E2EEHandles {
  private let lock = NSLock()
  private var next = 1
  private var objects: [Int: AnyObject] = [:]

  func put(_ o: AnyObject) -> Int {
    lock.lock(); defer { lock.unlock() }
    let h = next
    next += 1
    objects[h] = o
    return h
  }

  func get<T: AnyObject>(_ h: Int, _ type: T.Type) throws -> T {
    lock.lock(); defer { lock.unlock() }
    guard let o = objects[h] as? T else { throw E2EEBadHandle(h) }
    return o
  }

  func free(_ h: Int) {
    lock.lock(); defer { lock.unlock() }
    objects.removeValue(forKey: h)
  }

  var count: Int {
    lock.lock(); defer { lock.unlock() }
    return objects.count
  }
}

private final class E2EEBadHandle: Exception {
  init(_ h: Int) { self.h = h; super.init() }
  let h: Int
  override var reason: String { "e2ee: invalid handle \(h)" }
}

private final class E2EEBadKey: Exception {
  override var reason: String { "e2ee: pickle key must be 32 bytes (base64)" }
}

private final class E2EECoreError: Exception {
  init(_ e: Error) { self.msg = String(describing: e); super.init() }
  let msg: String
  override var reason: String { "e2ee: \(msg)" }
}

private func keyData(_ b64: String) throws -> Data {
  guard let d = Data(base64Encoded: b64), d.count == 32 else { throw E2EEBadKey() }
  return d
}

/// Runs a throwing Rust call and maps E2eeError → Expo exception (JS Error).
private func core<T>(_ f: () throws -> T) throws -> T {
  do { return try f() } catch let e as Exception { throw e } catch { throw E2EECoreError(error) }
}

public class ChatyyE2EEModule: Module {
  private let h = E2EEHandles()

  public func definition() -> ModuleDefinition {
    Name("ChatyyE2EE")

    // ---- diagnostics / availability
    Function("available") { () -> Bool in
      return !coreVersion().isEmpty
    }
    Function("coreVersion") { () -> String in coreVersion() }
    Function("liveHandles") { () -> Int in self.h.count }

    // ---- utilities
    Function("ed25519Verify") { (pk: String, msg: String, sig: String) -> Bool in
      ed25519Verify(publicKeyB64: pk, message: msg, signatureB64: sig)
    }
    Function("preKeySessionId") { (t: Int, b: String) -> String in
      guard t >= 0 && t <= Int(UInt32.max) else { return "" }
      return preKeySessionId(msgType: UInt32(t), bodyB64: b)
    }
    Function("randomBytes") { (n: Int) throws -> String in
      guard n > 0 && n <= 4096 else { throw E2EEBadKey() }
      var d = Data(count: n)
      let rc = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, n, $0.baseAddress!) }
      if rc != errSecSuccess { throw E2EECoreError(NSError(domain: "SecRandom", code: Int(rc))) }
      return d.base64EncodedString()
    }
    Function("sha512") { (b64: String) throws -> String in
      guard let d = Data(base64Encoded: b64) else { throw E2EEBadKey() }
      return Data(SHA512.hash(data: d)).base64EncodedString()
    }
    Function("free") { (handle: Int) in self.h.free(handle) }

    // ---- Olm account
    Function("accountNew") { () -> Int in self.h.put(OlmAccount()) }
    Function("accountFromPickle") { (pickle: String, key: String) throws -> Int in
      let k = try keyData(key)
      return self.h.put(try core { try OlmAccount.fromPickle(pickle: pickle, pickleKey: k) })
    }
    Function("accountPickle") { (a: Int, key: String) throws -> String in
      let k = try keyData(key)
      let acct = try self.h.get(a, OlmAccount.self)
      return try core { try acct.pickle(pickleKey: k) }
    }
    Function("accountCurve25519") { (a: Int) throws -> String in try self.h.get(a, OlmAccount.self).curve25519() }
    Function("accountEd25519") { (a: Int) throws -> String in try self.h.get(a, OlmAccount.self).ed25519() }
    Function("accountSign") { (a: Int, msg: String) throws -> String in try self.h.get(a, OlmAccount.self).sign(message: msg) }
    Function("accountGenerateOneTimeKeys") { (a: Int, n: Int) throws in
      guard n >= 0 && n <= 1000 else { throw E2EEBadKey() }
      try self.h.get(a, OlmAccount.self).generateOneTimeKeys(count: UInt32(n))
    }
    Function("accountOneTimeKeys") { (a: Int) throws -> String in try self.h.get(a, OlmAccount.self).oneTimeKeys() }
    Function("accountGenerateFallbackKey") { (a: Int) throws in try self.h.get(a, OlmAccount.self).generateFallbackKey() }
    Function("accountFallbackKey") { (a: Int) throws -> String in try self.h.get(a, OlmAccount.self).fallbackKey() }
    Function("accountMarkKeysAsPublished") { (a: Int) throws in try self.h.get(a, OlmAccount.self).markKeysAsPublished() }
    Function("accountMaxOneTimeKeys") { (a: Int) throws -> Int in Int(try self.h.get(a, OlmAccount.self).maxOneTimeKeys()) }
    Function("accountCreateOutboundSession") { (a: Int, ik: String, otk: String) throws -> Int in
      let acct = try self.h.get(a, OlmAccount.self)
      return self.h.put(try core { try acct.createOutboundSession(identityKeyB64: ik, oneTimeKeyB64: otk) })
    }
    Function("accountCreateInboundSession") { (a: Int, ik: String, t: Int, b: String) throws -> [String: Any] in
      guard t >= 0 && t <= Int(UInt32.max) else { throw E2EEBadKey() }
      let acct = try self.h.get(a, OlmAccount.self)
      let r = try core { try acct.createInboundSession(theirIdentityKeyB64: ik, msgType: UInt32(t), bodyB64: b) }
      return ["session": self.h.put(r.session), "plaintext": r.plaintext]
    }

    // ---- Olm session
    Function("sessionFromPickle") { (pickle: String, key: String) throws -> Int in
      let k = try keyData(key)
      return self.h.put(try core { try OlmSession.fromPickle(pickle: pickle, pickleKey: k) })
    }
    Function("sessionPickle") { (s: Int, key: String) throws -> String in
      let k = try keyData(key)
      let sess = try self.h.get(s, OlmSession.self)
      return try core { try sess.pickle(pickleKey: k) }
    }
    Function("sessionId") { (s: Int) throws -> String in try self.h.get(s, OlmSession.self).sessionId() }
    Function("sessionEncrypt") { (s: Int, pt: String) throws -> String in
      let sess = try self.h.get(s, OlmSession.self)
      return try core { try sess.encrypt(plaintext: pt) }
    }
    Function("sessionDecrypt") { (s: Int, t: Int, b: String) throws -> String in
      guard t >= 0 && t <= Int(UInt32.max) else { throw E2EEBadKey() }
      let sess = try self.h.get(s, OlmSession.self)
      return try core { try sess.decrypt(msgType: UInt32(t), bodyB64: b) }
    }

    // ---- Megolm (grupos — fase 2; exposto já para não exigir outro build)
    Function("megolmOutboundNew") { () -> Int in self.h.put(MegolmOutbound()) }
    Function("megolmOutboundFromPickle") { (pickle: String, key: String) throws -> Int in
      let k = try keyData(key)
      return self.h.put(try core { try MegolmOutbound.fromPickle(pickle: pickle, pickleKey: k) })
    }
    Function("megolmOutboundPickle") { (g: Int, key: String) throws -> String in
      let k = try keyData(key)
      let o = try self.h.get(g, MegolmOutbound.self)
      return try core { try o.pickle(pickleKey: k) }
    }
    Function("megolmOutboundSessionId") { (g: Int) throws -> String in try self.h.get(g, MegolmOutbound.self).sessionId() }
    Function("megolmOutboundSessionKey") { (g: Int) throws -> String in try self.h.get(g, MegolmOutbound.self).sessionKey() }
    Function("megolmOutboundEncrypt") { (g: Int, pt: String) throws -> String in try self.h.get(g, MegolmOutbound.self).encrypt(plaintext: pt) }
    Function("megolmInboundNew") { (sk: String) throws -> Int in
      return self.h.put(try core { try MegolmInbound(sessionKeyB64: sk) })
    }
    Function("megolmInboundFromPickle") { (pickle: String, key: String) throws -> Int in
      let k = try keyData(key)
      return self.h.put(try core { try MegolmInbound.fromPickle(pickle: pickle, pickleKey: k) })
    }
    Function("megolmInboundPickle") { (g: Int, key: String) throws -> String in
      let k = try keyData(key)
      let o = try self.h.get(g, MegolmInbound.self)
      return try core { try o.pickle(pickleKey: k) }
    }
    Function("megolmInboundSessionId") { (g: Int) throws -> String in try self.h.get(g, MegolmInbound.self).sessionId() }
    Function("megolmInboundDecrypt") { (g: Int, m: String) throws -> String in
      let o = try self.h.get(g, MegolmInbound.self)
      return try core { try o.decrypt(messageB64: m) }
    }
  }
}
