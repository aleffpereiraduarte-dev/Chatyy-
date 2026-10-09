import ExpoModulesCore

/// [2026-10-09 media-native] JS bridge for ChatTransferManager (background
/// chat media upload/download). JS: services/bgTransfer.js — loaded with
/// requireOptionalNativeModule('ChatyyTransfer'), so binaries without this
/// module keep the foreground path.
public class ChatTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyTransfer")

    Events("onTransferProgress", "onTransferDone")

    OnCreate {
      ChatTransferManager.shared.emitter = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
      ChatTransferManager.shared.ensureSession()
    }

    OnDestroy {
      ChatTransferManager.shared.emitter = nil
    }

    Function("isAvailable") { () -> Bool in
      return true
    }

    /// { id, fileUri, base, bearer, uploadId, chunkSize, totalSize,
    ///   skipChunks?, filename?, contentType?, userEmail?, context?, title? }
    AsyncFunction("enqueueUpload") { (spec: [String: Any]) -> Bool in
      return ChatTransferManager.shared.enqueueUpload(spec)
    }

    /// { id, url, dest, headers?, title? }
    AsyncFunction("enqueueDownload") { (spec: [String: Any]) -> Bool in
      return ChatTransferManager.shared.enqueueDownload(spec)
    }

    AsyncFunction("getTransfer") { (id: String) -> [String: Any]? in
      return ChatTransferManager.shared.get(id)
    }

    AsyncFunction("listTransfers") { () -> [[String: Any]] in
      return ChatTransferManager.shared.list()
    }

    AsyncFunction("cancel") { (id: String) in
      ChatTransferManager.shared.cancel(id)
    }

    AsyncFunction("forget") { (id: String) in
      ChatTransferManager.shared.forget(id)
    }

    AsyncFunction("updateBearer") { (bearer: String) in
      ChatTransferManager.shared.updateBearer(bearer)
    }

    AsyncFunction("kick") { () in
      ChatTransferManager.shared.kick()
    }
  }
}
