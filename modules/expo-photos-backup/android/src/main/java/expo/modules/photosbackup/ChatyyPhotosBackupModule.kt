package expo.modules.photosbackup

import android.content.Context
import androidx.work.WorkInfo
import androidx.work.WorkManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

// [2026-10-15 photos-native] Backup de fotos/vídeos NATIVO (Android).
// JS: modules/expo-photos-backup/index.ts. Contrato: SPEC (scratchpad photos/SPEC.md).
//   configure / signOut / start / pause / resume / runNow / getStatus / getSnapshot
//   eventos onProgress / onItem / onState (só com o JS vivo; o Worker roda sem ele).
// Isolamento por conta: banco pb_<acct>.sqlite; trocar de conta cancela o
// trabalho WorkManager com a tag da conta anterior antes de trocar.
class ChatyyPhotosBackupModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("no context")

  override fun definition() = ModuleDefinition {
    Name("ChatyyPhotosBackup")

    Events("onProgress", "onItem", "onState")

    OnCreate {
      PBEvents.listener = { name, body ->
        try { sendEvent(name, body) } catch (_: Throwable) {}
      }
    }

    OnDestroy {
      PBEvents.listener = null
    }

    Function("apiVersion") { 1 }

    AsyncFunction("configure") { opts: Map<String, Any?> ->
      val ctx = context
      val prefs = PBPrefs(ctx)
      val email = (opts["account"] as? String ?: "").trim().lowercase()
      if (email.isEmpty()) throw IllegalArgumentException("account required")
      val acct = PBPrefs.acctHash(email)
      val old = prefs.acct
      val switched = old.isNotEmpty() && old != acct
      if (switched) {
        // Para TUDO da conta anterior (uploads em voo são cancelados junto
        // com o Worker; o Worker também confere prefs.acct a cada item).
        PBScheduler.cancelAccount(ctx, old)
        PBScheduler.cancelAll(ctx)
      }
      val before = listOf(prefs.wifiOnly, prefs.chargingOnly, prefs.includeVideos, prefs.quality, prefs.enabled)
      prefs.account = email
      prefs.acct = acct
      (opts["token"] as? String)?.let { prefs.token = it }
      (opts["apiBase"] as? String)?.takeIf { it.isNotBlank() }?.let { prefs.apiBase = it.trim() }
      (opts["fallbackBase"] as? String)?.takeIf { it.isNotBlank() }?.let { prefs.fallbackBase = it.trim() }
      (opts["enabled"] as? Boolean)?.let { prefs.enabled = it }
      (opts["wifiOnly"] as? Boolean)?.let { prefs.wifiOnly = it }
      (opts["chargingOnly"] as? Boolean)?.let { prefs.chargingOnly = it }
      (opts["quality"] as? String)?.let { prefs.quality = if (it == "economy") "economy" else "original" }
      (opts["includeVideos"] as? Boolean)?.let { prefs.includeVideos = it }
      (opts["notify"] as? Boolean)?.let { prefs.notify = it }
      @Suppress("UNCHECKED_CAST")
      (opts["labels"] as? Map<String, Any?>)?.let { m ->
        val o = JSONObject()
        for ((k, v) in m) if (v is String) o.put(k, v)
        prefs.labelsJson = o.toString()
        PBWorker.ensureChannel(ctx, prefs)
      }
      if (switched) prefs.paused = false
      prefs.blockedBy = ""
      val after = listOf(prefs.wifiOnly, prefs.chargingOnly, prefs.includeVideos, prefs.quality, prefs.enabled)
      if (prefs.enabled && !prefs.paused && prefs.hasCreds()) {
        PBScheduler.schedule(ctx, prefs, replace = switched || before != after)
      } else {
        PBScheduler.cancelAll(ctx)
      }
      PBWorker.emitState(ctx, prefs)
      true
    }

    AsyncFunction("signOut") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      PBScheduler.cancelAll(ctx)
      prefs.token = ""
      prefs.blockedBy = "auth"
      PBWorker.emitState(ctx, prefs)
      true
    }

    AsyncFunction("start") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      prefs.enabled = true
      prefs.paused = false
      prefs.blockedBy = ""
      PBScheduler.schedule(ctx, prefs, replace = false)
      PBWorker.emitState(ctx, prefs)
      true
    }

    // [2026-10-15 photos-native] desliga o motor (kill switch JS / usuário desligou)
    AsyncFunction("stop") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      prefs.enabled = false
      PBScheduler.cancelAll(ctx)
      PBWorker.emitState(ctx, prefs)
      true
    }

    AsyncFunction("pause") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      prefs.paused = true
      PBScheduler.cancelAll(ctx)
      PBWorker.emitState(ctx, prefs)
      true
    }

    AsyncFunction("resume") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      prefs.paused = false
      prefs.blockedBy = ""
      PBScheduler.schedule(ctx, prefs, replace = false)
      PBWorker.emitState(ctx, prefs)
      true
    }

    AsyncFunction("runNow") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      if (prefs.acct.isNotEmpty()) PBStore.get(ctx, prefs.acct).clearBackoff()
      prefs.blockedBy = ""
      PBScheduler.schedule(ctx, prefs, replace = false)
      true
    }

    AsyncFunction("getStatus") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      val out = HashMap<String, Any?>()
      out["enabled"] = prefs.enabled
      out["paused"] = prefs.paused
      out["account"] = prefs.acct
      out["lastRunAt"] = prefs.lastRunAt
      out["lastError"] = prefs.lastError.ifEmpty { null }
      var blocked: String? = prefs.blockedBy.ifEmpty { null }
      if (blocked == null) {
        val g = PBScheduler.gate(ctx, prefs)
        if (!g.isNullOrEmpty() && g != "disabled") blocked = g
      }
      if (!prefs.enabled) blocked = "disabled"
      out["blockedBy"] = blocked
      var running = PBWorker.running
      if (!running) {
        running = try {
          WorkManager.getInstance(ctx).getWorkInfosByTag(PBScheduler.TAG_ALL).get()
            .any { it.state == WorkInfo.State.RUNNING }
        } catch (_: Throwable) { false }
      }
      out["running"] = running
      if (prefs.acct.isNotEmpty()) {
        val s = PBStore.get(ctx, prefs.acct)
        val c = s.counts()
        out["total"] = c.total; out["done"] = c.done; out["pending"] = c.pending
        out["uploading"] = c.uploading; out["failed"] = c.failed; out["skipped"] = c.skipped
        out["bytesDone"] = s.meta("bytesDone")?.toLongOrNull() ?: 0L
      } else {
        out["total"] = 0; out["done"] = 0; out["pending"] = 0
        out["uploading"] = 0; out["failed"] = 0; out["skipped"] = 0; out["bytesDone"] = 0L
      }
      out
    }

    AsyncFunction("getSnapshot") {
      val ctx = context
      val prefs = PBPrefs(ctx)
      if (prefs.acct.isEmpty()) {
        mapOf("cloud" to emptyList<String>(), "pending" to emptyList<String>(),
          "uploading" to emptyList<String>(), "failed" to emptyList<String>(), "local" to emptyList<String>())
      } else {
        PBStore.get(ctx, prefs.acct).snapshot()
      }
    }
  }
}
