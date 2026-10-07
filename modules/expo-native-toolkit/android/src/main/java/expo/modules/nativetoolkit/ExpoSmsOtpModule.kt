package expo.modules.nativetoolkit

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.os.BundleCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * [2026-10-08 android-otp-shortcuts] SMS User Consent API (Android only).
 *
 * Flow:
 *   1. JS calls start() when the OTP step is shown.
 *   2. SmsRetriever.startSmsUserConsent(null) arms a 5-minute window; Play
 *      Services broadcasts SMS_RETRIEVED_ACTION when an SMS with a 4-10 char
 *      alphanumeric code arrives (sender must NOT be in the user's contacts).
 *   3. The broadcast carries a consent Intent → we launch it on the current
 *      activity (system bottom sheet "Permitir que o Chatyy leia esta mensagem?").
 *   4. OnActivityResult → full SMS text → extract the 6-digit code → emit
 *      "onSmsOtp" { code } to JS. Only the code leaves native (never the body).
 *
 * No READ_SMS permission, no app hash in the SMS (that is the SMS Retriever
 * API, which needs a server-side hash). Statement-form try only.
 */
class ExpoSmsOtpModule : Module() {

  companion object {
    private const val TAG = "ExpoSmsOtp"
    private const val REQ_CONSENT = 0x5E0C
    private const val EVENT = "onSmsOtp"
    private val CODE_6 = Regex("(?<!\\d)(\\d{6})(?!\\d)")
    private val CODE_3_3 = Regex("(?<!\\d)(\\d{3})[\\s-](\\d{3})(?!\\d)")

    fun extractCode(message: String?): String? {
      if (message.isNullOrBlank()) return null
      val m6 = CODE_6.find(message)
      if (m6 != null) return m6.groupValues[1]
      val m33 = CODE_3_3.find(message)
      if (m33 != null) return m33.groupValues[1] + m33.groupValues[2]
      return null
    }
  }

  private var receiver: BroadcastReceiver? = null
  private var receiverCtx: Context? = null
  private var consentPending = false

  override fun definition() = ModuleDefinition {
    Name("ExpoSmsOtp")
    Events(EVENT)

    Function("isAvailable") {
      var ok = false
      try {
        Class.forName("com.google.android.gms.auth.api.phone.SmsRetriever")
        ok = true
      } catch (_: Throwable) {
        ok = false
      }
      ok
    }

    // Arms the consent window. Idempotent: a second call re-arms (Play
    // Services just restarts the 5-min timer) and keeps a single receiver.
    AsyncFunction("start") {
      val ctx = appContext.reactContext?.applicationContext
      var started = false
      if (ctx != null) {
        try {
          registerReceiverOnce(ctx)
          SmsRetriever.getClient(ctx).startSmsUserConsent(null)
            .addOnFailureListener { e -> Log.w(TAG, "startSmsUserConsent failed: ${e.message}") }
          started = true
        } catch (t: Throwable) {
          Log.w(TAG, "start failed: ${t.message}")
          unregisterReceiverSafe()
        }
      }
      started
    }

    Function("stop") {
      unregisterReceiverSafe()
      consentPending = false
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQ_CONSENT) return@OnActivityResult
      consentPending = false
      if (payload.resultCode == Activity.RESULT_OK) {
        val msg = payload.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE)
        val code = extractCode(msg)
        if (code != null) {
          sendEvent(EVENT, mapOf("status" to "code", "code" to code))
        } else {
          sendEvent(EVENT, mapOf("status" to "no_code"))
        }
      } else {
        sendEvent(EVENT, mapOf("status" to "denied"))
      }
      // One-shot: JS re-arms via start() on resend.
      unregisterReceiverSafe()
    }

    OnDestroy {
      unregisterReceiverSafe()
    }
  }

  private fun registerReceiverOnce(ctx: Context) {
    if (receiver != null) return
    val r = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
        val extras = intent.extras ?: return
        var status: Status? = null
        try {
          status = BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_STATUS, Status::class.java)
        } catch (t: Throwable) {
          Log.w(TAG, "status parse failed: ${t.message}")
        }
        when (status?.statusCode) {
          CommonStatusCodes.SUCCESS -> {
            var consent: Intent? = null
            try {
              consent = BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java)
            } catch (t: Throwable) {
              Log.w(TAG, "consent intent parse failed: ${t.message}")
            }
            if (consent != null) launchConsent(consent)
          }
          CommonStatusCodes.TIMEOUT -> {
            sendEvent(EVENT, mapOf("status" to "timeout"))
            unregisterReceiverSafe()
          }
          else -> {}
        }
      }
    }
    val filter = IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION)
    // Exported (the sender is Play Services, another process) but locked to
    // holders of SmsRetriever.SEND_PERMISSION (only GMS holds it).
    ContextCompat.registerReceiver(ctx, r, filter, SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED)
    receiver = r
    receiverCtx = ctx
  }

  private fun launchConsent(consent: Intent) {
    val activity = appContext.currentActivity
    if (activity == null || consentPending) return
    // Intent-redirection hardening: only launch if it resolves to Play
    // Services and carries no URI grants.
    var safe = false
    try {
      val target = consent.resolveActivity(activity.packageManager)
      val grants = consent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      safe = target != null && target.packageName == "com.google.android.gms" && grants == 0
    } catch (t: Throwable) {
      Log.w(TAG, "consent resolve failed: ${t.message}")
    }
    if (!safe) {
      Log.w(TAG, "consent intent rejected (not GMS)")
      return
    }
    try {
      consentPending = true
      activity.startActivityForResult(consent, REQ_CONSENT)
    } catch (t: Throwable) {
      consentPending = false
      Log.w(TAG, "consent launch failed: ${t.message}")
    }
  }

  private fun unregisterReceiverSafe() {
    val r = receiver
    val c = receiverCtx
    receiver = null
    receiverCtx = null
    if (r != null && c != null) {
      try {
        c.unregisterReceiver(r)
      } catch (_: Throwable) {
      }
    }
  }
}
