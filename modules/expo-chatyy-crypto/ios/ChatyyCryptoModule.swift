// [e2ee5 WP-03] Módulo Expo "ChatyyCrypto" (iOS): casca fina sobre `ChatyyCrypto.shared`.
//
// JS (modules/expo-chatyy-crypto/index.ts → services/crypto/index.native.js):
//   info()                         → {apiVersion, coreLinked, platform, process}   (síncrono)
//   nativeEnabled(uid)             → Bool (último e2ee5_native gravado; síncrono)
//   invoke(op, argsJson)           → Promise<String JSON {"v": resultado}>
//   eventos: onSyncResult, onNewKeys, onIdentityChanged, onIdentityViolation, onNativeFlag
// Erro: reject(code, "e2ee5:<code> <detalhes JSON>") — o JS remonta `.code/.details/.reason`.
//
// Sem o núcleo no binário (build normal, sem chatyy_crypto=true) o módulo existe como STUB:
// coreLinked=false e toda chamada rejeita com 'unsupported'. Nada liga para o usuário.
import ExpoModulesCore
import Foundation

public class ChatyyCryptoModule: Module {
  #if CHATYY_CRYPTO_CORE
  private var listenerId: UUID?
  #endif

  public func definition() -> ModuleDefinition {
    Name("ChatyyCrypto")

    Events("onSyncResult", "onNewKeys", "onIdentityChanged", "onIdentityViolation", "onNativeFlag")

    Function("info") { () -> [String: Any] in
      #if CHATYY_CRYPTO_CORE
      let linked = true
      #else
      let linked = false
      #endif
      return ["apiVersion": ChatyyCryptoConst.apiVersion, "coreLinked": linked, "platform": "ios",
              "process": ChatyyProcessKind.current.rawValue]
    }

    Function("nativeEnabled") { (uid: String) -> Bool in
      return uid.isEmpty ? ChatyyCryptoFlags.nativeForLast() : ChatyyCryptoFlags.native(uid: uid)
    }

    // [2026-10-22] Panic do núcleo gravado no App Group (app/NSE): lê+apaga; "" = nada.
    Function("takePanicReport") { () -> String in
      return ChatyyCryptoPanic.take()
    }

    AsyncFunction("invoke") { (op: String, args: String, promise: Promise) in
      #if CHATYY_CRYPTO_CORE
      Task {
        do {
          let r = try await ChatyyCrypto.shared.invoke(op: op, args: args)
          promise.resolve(r)
        } catch {
          let (code, details) = ChatyyCrypto.describe(error)
          promise.reject(code, "e2ee5:\(code) " + ChatyyCryptoJSON.string(details))
        }
      }
      #else
      promise.reject("unsupported", "e2ee5:unsupported {\"what\":\"core_not_linked\"}")
      #endif
    }

    OnStartObserving {
      #if CHATYY_CRYPTO_CORE
      if self.listenerId != nil { return }
      let id = UUID()
      self.listenerId = id
      Task { [weak self] in
        await ChatyyCrypto.shared.addListenerWithId(id) { name, body in
          self?.sendEvent(name, body.mapValues { Optional($0) })
        }
      }
      #endif
    }

    OnStopObserving {
      #if CHATYY_CRYPTO_CORE
      if let id = self.listenerId {
        self.listenerId = nil
        Task { await ChatyyCrypto.shared.removeListener(id) }
      }
      #endif
    }
  }
}
