import ExpoModulesCore

// [2026-10-15 photos-native] Ponte JS do backup de fotos nativo.
// JS: modules/expo-photos-backup/index.ts + services/photosBackupNative.js.
// O motor (PBEngine) vive sem o JS (BGTask / sessão background); o módulo só
// configura, consulta e repassa eventos quando o JS está vivo.
public class ChatyyPhotosBackupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyPhotosBackup")

    Events("onProgress", "onItem", "onState")

    Function("apiVersion") { () -> Int in
      return 1
    }

    // BGTaskScheduler.register SÓ no didFinishLaunching (AppDelegateSubscriber):
    // registrar aqui depois do launch derruba o app no iOS 18.
    OnCreate {
      let engine = PBEngine.shared
      let emitter: (String, [String: Any]) -> Void = { [weak self] name, body in
        var b: [String: Any?] = [:]
        for (k, v) in body { b[k] = v }
        self?.sendEvent(name, b)
      }
      engine.q.async { engine.emit = emitter }
    }

    OnDestroy {
      let engine = PBEngine.shared
      engine.q.async { engine.emit = nil }
    }

    AsyncFunction("configure") { (opts: [String: Any], promise: Promise) in
      PBEngine.shared.configure(opts) { promise.resolve(true) }
    }

    AsyncFunction("signOut") { (promise: Promise) in
      PBEngine.shared.signOut { promise.resolve(true) }
    }

    AsyncFunction("start") { () -> Bool in
      PBEngine.shared.setEnabled(true)
      return true
    }

    AsyncFunction("stop") { () -> Bool in
      PBEngine.shared.setEnabled(false)
      return true
    }

    AsyncFunction("pause") { () -> Bool in
      PBEngine.shared.setPaused(true)
      return true
    }

    AsyncFunction("resume") { () -> Bool in
      PBEngine.shared.setPaused(false)
      return true
    }

    AsyncFunction("runNow") { () -> Bool in
      PBEngine.shared.runNow()
      return true
    }

    AsyncFunction("getStatus") { () -> [String: Any] in
      return PBEngine.shared.status()
    }

    AsyncFunction("getSnapshot") { () -> [String: [String]] in
      return PBEngine.shared.snapshot()
    }
  }
}
