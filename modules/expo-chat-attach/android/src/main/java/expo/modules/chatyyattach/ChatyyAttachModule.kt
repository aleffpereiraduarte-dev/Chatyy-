package expo.modules.chatyyattach

import android.os.Looper
import android.os.SystemClock
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

  // [2026-10-21 attach-android-armed] folha "armada" pelo JS (= iOS api 10-12):
  // o "+" do composer nativo (api 8, AttachPlusHub por reflexão) a apresenta
  // NO MESMO TOQUE, sem ida ao JS. Fica PRÉ-MONTADA (Dialog.create(): views +
  // galeria em 2º plano) num idle da main depois de armar; resultado vai pelo
  // evento onArmedResult {id, result, timing}.
  private var armedOpts: Map<String, Any?>? = null
  private var armedId = ""
  private var prebuilt: AttachSheetDialog? = null
  private var prebuildGen = 0
  @Volatile private var armedOpenId = ""

  override fun definition() = ModuleDefinition {
    Name("ChatyyAttach")

    // 3 = câmera com statusModes (Texto · Normal · Boomerang) [2026-10-15 native-status-studio]
    // 4 = [2026-10-21 attach-android-armed] armSheet(id, options|null) +
    //     isArmedOpen(id) + eventos onArmedShown {id, immediate, showMs, waitMs}
    //     (após a descida do IME do composer) / onArmedResult {id, result,
    //     timing {show, anim, fetch, assets, n} ms desde o toque}; folha
    //     pré-montada, entra no quadro do "+" (composer api 8) com o IME
    //     descendo por trás; galeria em 2 etapas fora da main. Opções:
    //     tgWaitKeyboard=true = só entra depois da descida; noPrebuild=true =
    //     monta no toque (sem pré-montagem).
    Function("apiVersion") { 4 }

    OnCreate {
      AttachPlusHub.owner = java.lang.ref.WeakReference(this@ChatyyAttachModule)
    }

    OnDestroy {
      val me = this@ChatyyAttachModule
      if (AttachPlusHub.owner?.get() === me) AttachPlusHub.owner = null
      CAUtil.main.post {
        armedOpts = null
        armedId = ""
        prebuildGen++
        discardPrebuilt()
      }
    }

    Events("onArmedResult", "onArmedShown")

    // [2026-10-21 attach-android-armed] JS deixa as opções prontas (id = dono). null/{} = desarma.
    AsyncFunction("armSheet") { id: String, options: Map<String, Any?>? ->
      if (options != null && options.isNotEmpty()) {
        val same = armedId == id && armedOpts == options
        armedOpts = options
        armedId = id
        if (!same) { discardPrebuilt(); schedulePrebuild(700L) }
        else if (prebuilt == null) schedulePrebuild(700L)
      } else if (armedId == id) {
        armedOpts = null
        armedId = ""
        prebuildGen++
        discardPrebuilt()
      }
      true
    }.runOnQueue(Queues.MAIN)

    // Síncrono (thread do JS): a folha armada deste dono está na tela?
    Function("isArmedOpen") { id: String -> id.isNotEmpty() && armedOpenId == id }

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

  // ─── [2026-10-21 attach-android-armed] ─────────────────────────────────

  private fun discardPrebuilt() {
    val d = prebuilt ?: return
    prebuilt = null
    try { d.discard() } catch (_: Throwable) {}
  }

  /** Pré-monta num idle da main (nunca no quadro do toque nem na abertura da conversa). */
  private fun schedulePrebuild(delayMs: Long) {
    val gen = ++prebuildGen
    if (armedOpts?.get("noPrebuild") == true) return
    CAUtil.main.postDelayed({
      if (gen != prebuildGen) return@postDelayed
      try {
        Looper.myQueue().addIdleHandler {
          if (gen == prebuildGen) doPrebuild()
          false
        }
      } catch (_: Throwable) {}
    }, delayMs)
  }

  private fun doPrebuild() {
    val opts = armedOpts ?: return
    if (prebuilt != null || sheet != null || camera != null || vnote != null) return
    if (opts["noPrebuild"] == true) return
    val activity = appContext.currentActivity ?: return
    if (activity.isFinishing || activity.isDestroyed) return
    CAImeProbe.install(activity)
    val dlg = makeArmedDialog(activity, CAConfig(opts), armedId)
    if (dlg.prepare()) prebuilt = dlg else try { dlg.discard() } catch (_: Throwable) {}
  }

  private fun makeArmedDialog(activity: android.app.Activity, cfg: CAConfig, id: String): AttachSheetDialog {
    var done = false
    var dlg: AttachSheetDialog? = null
    dlg = AttachSheetDialog(activity, cfg, { cb -> ask(CAUtil.mediaPermissions(), cb) }) { result ->
      if (done) return@AttachSheetDialog
      done = true
      val d = dlg
      if (prebuilt === d) prebuilt = null
      if (d == null || !d.armedPresented) return@AttachSheetDialog // pré-montada que nunca apareceu
      if (sheet === d) sheet = null
      if (armedOpenId == id) armedOpenId = ""
      val body = HashMap<String, Any?>()
      body["id"] = id
      body["result"] = result
      if (d.openTiming.isNotEmpty()) body["timing"] = HashMap<String, Any?>(d.openTiming)
      try { sendEvent("onArmedResult", body) } catch (t: Throwable) { Log.w(TAG, "armed result: ${t.message}") }
      if (armedOpts != null && armedId == id) schedulePrebuild(500L) // próxima já pronta
    }
    return dlg
  }

  /** Toque no "+" do composer (main thread). true = folha apresentada aqui. */
  internal fun onComposerPlus(info: Map<String, Any?>): Boolean {
    val opts = armedOpts ?: return false
    if (sheet != null || camera != null || vnote != null) return false
    val activity = appContext.currentActivity ?: return false
    if (activity.isFinishing || activity.isDestroyed) return false
    val id = armedId
    val tapAt = (info["tapAt"] as? Number)?.toLong()?.takeIf { it > 0 } ?: SystemClock.uptimeMillis()
    val had = info["hadKeyboard"] == true
    var dlg = prebuilt
    prebuilt = null
    prebuildGen++
    if (dlg != null && (dlg.hostActivity !== activity || dlg.isFinished)) { try { dlg.discard() } catch (_: Throwable) {}; dlg = null }
    val d = dlg ?: makeArmedDialog(activity, CAConfig(opts), id)
    d.tapAt = tapAt
    d.armedPresented = true
    sheet = d
    armedOpenId = id
    val waitKb = had && opts["tgWaitKeyboard"] == true
    val fail = {
      if (sheet === d) sheet = null
      if (armedOpenId == id) armedOpenId = ""
      d.armedPresented = false
      try { d.discard() } catch (_: Throwable) {}
    }
    val present: () -> Boolean = present@{
      if (sheet !== d) return@present false
      try {
        d.show()
        d.onArmedPresent()
        true
      } catch (t: Throwable) {
        Log.w(TAG, "armed show failed: ${t.message}")
        false
      }
    }
    if (waitKb) {
      // comportamento antigo (kill switch): entra só depois da descida do IME
      CAImeProbe.afterImeHidden(activity, 650L) { waited ->
        if (sheet !== d) return@afterImeHidden
        if (!present()) {
          fail()
          try { sendEvent("onArmedResult", mapOf("id" to id, "result" to null)) } catch (_: Throwable) {}
          return@afterImeHidden
        }
        val showMs = (SystemClock.uptimeMillis() - tapAt).toInt()
        try { sendEvent("onArmedShown", mapOf("id" to id, "immediate" to false, "showMs" to showMs, "waitMs" to waited)) } catch (_: Throwable) {}
      }
      return true
    }
    if (!present()) { fail(); return false }
    val showMs = (SystemClock.uptimeMillis() - tapAt).toInt()
    val notify = { waited: Int ->
      // folha já fechou antes do fim da descida → nada de ignorar o teclado
      if (sheet === d) {
        try { sendEvent("onArmedShown", mapOf("id" to id, "immediate" to true, "showMs" to showMs, "waitMs" to waited)) } catch (_: Throwable) {}
      }
    }
    if (had) CAImeProbe.afterImeHidden(activity, 650L) { w -> notify(w) } else CAUtil.main.post { notify(0) }
    return true
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
