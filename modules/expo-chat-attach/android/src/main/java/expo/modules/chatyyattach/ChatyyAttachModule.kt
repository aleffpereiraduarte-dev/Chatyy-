package expo.modules.chatyyattach

import android.util.Log
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-15 native-attach] Folha de anexos + câmera do chat em nativo.
 * JS (modules/expo-chat-attach/index.ts):
 *   openSheet(options)  → { action: 'send'|'preview'|'action'|'cancel', … }
 *   openCamera(options) → { action: 'capture'|'pick'|'gallery'|'cancel', … }
 *   prewarmCamera() / releaseCamera() / dismiss()
 * Não conseguiu apresentar (sem Activity) → resolve null → JS usa o fallback.
 */
class ChatyyAttachModule : Module() {

  companion object { private const val TAG = "ChatyyAttach" }

  private var sheet: AttachSheetDialog? = null
  private var camera: ChatCameraDialog? = null
  private var vnote: VideoNoteDialog? = null

  override fun definition() = ModuleDefinition {
    Name("ChatyyAttach")

    // 3 = câmera com statusModes (Texto · Normal · Boomerang) [2026-10-15 native-status-studio]
    Function("apiVersion") { 3 }

    Function("isCameraSupported") {
      val ctx = appContext.reactContext ?: return@Function false
      ctx.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_ANY)
    }

    // [2026-10-15 native-vnote] Gravador de vídeo-recado redondo.
    Function("isVideoNoteSupported") {
      val ctx = appContext.reactContext ?: return@Function false
      ctx.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_CAMERA_ANY)
    }

    AsyncFunction("openVideoNote") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing) { promise.resolve(null); return@AsyncFunction }
      vnote?.let { old -> vnote = null; try { old.finishSilently() } catch (_: Throwable) {} }
      val cfg = VNConfig(options)
      var done = false
      var dlg: VideoNoteDialog? = null
      dlg = VideoNoteDialog(activity, cfg, { perms, cb -> ask(perms, cb) }) { result ->
        if (done) return@VideoNoteDialog
        done = true
        if (vnote === dlg) vnote = null
        promise.resolve(result)
      }
      vnote = dlg
      try {
        dlg.show()
      } catch (t: Throwable) {
        Log.w(TAG, "video note show failed: ${t.message}")
        vnote = null
        if (!done) { done = true; promise.resolve(null) }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("prewarmCamera") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      CameraHub.prewarm(ctx)
      CAUtil.hasCamera(ctx)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("releaseCamera") {
      // CameraX mantém só o provider (barato); nada a soltar sem tela aberta.
      true
    }

    AsyncFunction("openSheet") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing) { promise.resolve(null); return@AsyncFunction }
      sheet?.let { old -> sheet = null; try { old.finishSilently() } catch (_: Throwable) {} }
      val cfg = CAConfig(options)
      var done = false
      var dlg: AttachSheetDialog? = null
      dlg = AttachSheetDialog(activity, cfg, { cb -> ask(CAUtil.mediaPermissions(), cb) }) { result ->
        if (done) return@AttachSheetDialog
        done = true
        if (sheet === dlg) sheet = null
        promise.resolve(result)
      }
      sheet = dlg
      try {
        dlg.show()
      } catch (t: Throwable) {
        Log.w(TAG, "sheet show failed: ${t.message}")
        sheet = null
        if (!done) { done = true; promise.resolve(null) }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("openCamera") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || activity.isFinishing) { promise.resolve(null); return@AsyncFunction }
      camera?.let { old -> camera = null; try { old.finishSilently() } catch (_: Throwable) {} }
      val cfg = CAConfig(options)
      var done = false
      var dlg: ChatCameraDialog? = null
      dlg = ChatCameraDialog(activity, cfg, { perms, cb -> ask(perms, cb) }) { result ->
        if (done) return@ChatCameraDialog
        done = true
        if (camera === dlg) camera = null
        promise.resolve(result)
      }
      camera = dlg
      try {
        dlg.show()
      } catch (t: Throwable) {
        Log.w(TAG, "camera show failed: ${t.message}")
        camera = null
        if (!done) { done = true; promise.resolve(null) }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("dismiss") {
      var any = false
      sheet?.let { any = true; it.finish(mapOf("action" to "cancel")) }
      camera?.let { any = true; it.finish(mapOf("action" to "cancel")) }
      vnote?.let { any = true; it.finish(mapOf("action" to "cancel")) }
      any
    }.runOnQueue(Queues.MAIN)
  }

  /** Pede permissões pelo gerenciador do Expo; cb sempre na main thread. */
  private fun ask(perms: Array<String>, cb: () -> Unit) {
    val p = appContext.permissions
    if (p == null) { CAUtil.main.post(cb); return }
    try {
      p.askForPermissions(PermissionsResponseListener { _ -> CAUtil.main.post(cb) }, *perms)
    } catch (t: Throwable) {
      Log.w(TAG, "ask permissions failed: ${t.message}")
      CAUtil.main.post(cb)
    }
  }
}
