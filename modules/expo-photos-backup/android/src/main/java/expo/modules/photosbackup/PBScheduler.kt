package expo.modules.photosbackup

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

// [2026-10-15 photos-native] Agendamento WorkManager + portões (gates).
//   chatyy_photos_backup          OneTime (KEEP) — a rodada principal
//   chatyy_photos_backup_periodic Periódico 1 h (rede de segurança)
//   chatyy_photos_backup_trigger  ContentUriTriggers (foto/vídeo novo) → re-armado a cada disparo
//   chatyy_photos_backup_retry    OneTime com atraso = próximo backoff
// Toda request leva as tags "pb" e "pb_acct_<acct>" (troca de conta cancela só a da conta velha).
internal object PBScheduler {
  const val WORK_MAIN = "chatyy_photos_backup"
  const val WORK_PERIODIC = "chatyy_photos_backup_periodic"
  const val WORK_TRIGGER = "chatyy_photos_backup_trigger"
  const val WORK_RETRY = "chatyy_photos_backup_retry"
  const val TAG_ALL = "pb"
  const val TAG_TRIGGER = "pb_trigger"
  const val KEY_ACCT = "acct"
  const val KEY_KIND = "kind"

  fun acctTag(acct: String) = "pb_acct_$acct"

  private fun constraints(prefs: PBPrefs, withTrigger: Boolean = false): Constraints {
    val b = Constraints.Builder()
      .setRequiredNetworkType(if (prefs.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
      .setRequiresCharging(prefs.chargingOnly)
      .setRequiresBatteryNotLow(true)
      .setRequiresStorageNotLow(true)
    if (withTrigger) {
      b.addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
      b.addContentUriTrigger(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true)
      b.setTriggerContentUpdateDelay(5, TimeUnit.SECONDS)
      b.setTriggerContentMaxDelay(60, TimeUnit.SECONDS)
    }
    return b.build()
  }

  private fun input(acct: String, kind: String): Data =
    Data.Builder().putString(KEY_ACCT, acct).putString(KEY_KIND, kind).build()

  /** Agenda tudo (principal + periódico + gatilho). replace=true quando mudaram as regras. */
  fun schedule(context: Context, prefs: PBPrefs, replace: Boolean) {
    if (!prefs.enabled || prefs.paused || !prefs.hasCreds()) return
    val wm = WorkManager.getInstance(context)
    val acct = prefs.acct
    val main = OneTimeWorkRequestBuilder<PBWorker>()
      .setConstraints(constraints(prefs))
      .setInputData(input(acct, "main"))
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
      .addTag(TAG_ALL).addTag(acctTag(acct))
      .build()
    wm.enqueueUniqueWork(WORK_MAIN, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, main)

    val periodic = PeriodicWorkRequestBuilder<PBWorker>(1, TimeUnit.HOURS)
      .setConstraints(constraints(prefs))
      .setInputData(input(acct, "periodic"))
      .addTag(TAG_ALL).addTag(acctTag(acct))
      .build()
    wm.enqueueUniquePeriodicWork(
      WORK_PERIODIC,
      if (replace) ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE else ExistingPeriodicWorkPolicy.KEEP,
      periodic
    )
    armTrigger(context, prefs, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP)
  }

  /** Gatilho por conteúdo do MediaStore (one-shot: o Worker re-arma ao rodar). */
  fun armTrigger(context: Context, prefs: PBPrefs, policy: ExistingWorkPolicy) {
    if (!prefs.enabled || prefs.paused || !prefs.hasCreds()) return
    val acct = prefs.acct
    val req = OneTimeWorkRequestBuilder<PBWorker>()
      .setConstraints(constraints(prefs, withTrigger = true))
      .setInputData(input(acct, "trigger"))
      .addTag(TAG_ALL).addTag(acctTag(acct)).addTag(TAG_TRIGGER)
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(WORK_TRIGGER, policy, req)
  }

  /** Próxima tentativa (backoff) — roda depois de `delaySec`. */
  fun scheduleRetry(context: Context, prefs: PBPrefs, delaySec: Long) {
    if (!prefs.enabled || prefs.paused || !prefs.hasCreds()) return
    val acct = prefs.acct
    val req = OneTimeWorkRequestBuilder<PBWorker>()
      .setConstraints(constraints(prefs))
      .setInitialDelay(delaySec.coerceIn(15L, 6 * 3600L), TimeUnit.SECONDS)
      .setInputData(input(acct, "retry"))
      .addTag(TAG_ALL).addTag(acctTag(acct))
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(WORK_RETRY, ExistingWorkPolicy.APPEND_OR_REPLACE, req)
  }

  fun cancelAll(context: Context) {
    WorkManager.getInstance(context).cancelAllWorkByTag(TAG_ALL)
  }

  fun cancelAccount(context: Context, acct: String) {
    if (acct.isEmpty()) return
    WorkManager.getInstance(context).cancelAllWorkByTag(acctTag(acct))
  }

  // ── portões (checados também DENTRO do Worker, a cada item) ─────────
  data class Power(val charging: Boolean, val level: Int)

  fun power(context: Context): Power {
    val i: Intent? = try {
      context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    } catch (_: Throwable) { null }
    val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    val lvl = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
    val pct = if (lvl >= 0 && scale > 0) lvl * 100 / scale else 100
    return Power(charging, pct)
  }

  /** null = pode rodar; senão o motivo (SPEC blockedBy). "" = sem rede (silencioso). */
  fun gate(context: Context, prefs: PBPrefs): String? {
    if (!prefs.enabled) return "disabled"
    if (!prefs.hasCreds()) return "auth"
    if (!PBScanner.hasPermission(context)) return "permission"
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    val caps = try { cm?.getNetworkCapabilities(cm.activeNetwork) } catch (_: Throwable) { null }
    if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
      return if (prefs.wifiOnly) "wifi" else ""
    }
    if (prefs.wifiOnly && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) return "wifi"
    val p = power(context)
    if (prefs.chargingOnly && !p.charging) return "charging"
    if (!p.charging) {
      if (p.level in 0..19) return "battery"
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (pm?.isPowerSaveMode == true) return "battery"
    }
    return null
  }
}
