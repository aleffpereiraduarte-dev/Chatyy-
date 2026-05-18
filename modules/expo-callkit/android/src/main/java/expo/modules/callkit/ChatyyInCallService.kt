package expo.modules.callkit

import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * ChatyyInCallService — Android Telecom / InCallService integration (2026-05-17).
 *
 * Why: WhatsApp / Telegram-grade calls show up in the stock Android dialer
 * (Recents tab + lock-screen UI) because they register a self-managed
 * ConnectionService + PhoneAccountHandle with TelecomManager and let the
 * OS route the call lifecycle (including incoming UI on lock screen) through
 * the system. Before this service, our incoming UX relied on a foreground
 * `CallRingingService` + `IncomingCallActivity` overlay, which works but
 * is invisible to the system dialer.
 *
 * Architecture (deferred / minimal scaffold):
 *   - This file ships the service stub + the PhoneAccountHandle registration
 *     hook. The matching ConnectionService that actually owns each Call
 *     instance is NOT in this commit — that's a deeper migration that
 *     touches CallRingingService, IncomingCallActivity, the Sieve push
 *     pipeline (push-notify.php) and the entire WS call_invite flow.
 *   - The InCallService base class is enough for the OS to surface our
 *     "Chatyy" account in Settings → Calling Accounts, which is the first
 *     bit of WhatsApp parity. Long-term we'll bind a ConnectionService and
 *     hand each call_invite to TelecomManager.addNewIncomingCall() instead
 *     of starting IncomingCallActivity ourselves.
 *
 * Registration: call [registerPhoneAccount] once at app boot (e.g. from
 * MainApplication.onCreate or ExpoCallKitModule.setup). It is idempotent
 * — TelecomManager dedupes by ComponentName + accountId.
 *
 * Manifest entry (separate change): registers this class as a service with
 * the BIND_INCALL_SERVICE permission so the system can bind it.
 */
class ChatyyInCallService : InCallService() {

  companion object {
    private const val TAG = "ChatyyInCall"

    /** Stable account id under our package — TelecomManager keys by this
     *  string + the ComponentName so we use a single account for all
     *  Chatyy calls (incoming + outgoing). */
    private const val ACCOUNT_ID = "chatyy_voice"

    /** Display label users see in Settings → Calling Accounts. */
    private const val ACCOUNT_LABEL = "Chatyy"

    /**
     * Register the Chatyy PhoneAccount with the system TelecomManager. Safe
     * to call multiple times — the registration call replaces any existing
     * account with the same handle. Returns true when the account is now
     * registered (or was already registered).
     *
     * Requires Android O (8.0) for self-managed accounts; on older Android
     * we no-op and the legacy IncomingCallActivity path keeps full control.
     */
    @JvmStatic
    fun registerPhoneAccount(ctx: Context): Boolean {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        Log.i(TAG, "registerPhoneAccount: pre-O — skipping (legacy ringing path is canonical)")
        return false
      }
      return try {
        val tm = ctx.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
          ?: return false.also { Log.w(TAG, "TelecomManager not available") }
        val handle = phoneAccountHandle(ctx)
        val account = PhoneAccount.builder(handle, ACCOUNT_LABEL)
          .setCapabilities(
            PhoneAccount.CAPABILITY_SELF_MANAGED or
            PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING or
            PhoneAccount.CAPABILITY_VIDEO_CALLING
          )
          .setShortDescription("Chatyy voice + video")
          .build()
        tm.registerPhoneAccount(account)
        Log.i(TAG, "PhoneAccount registered: ${handle.id}")
        true
      } catch (t: Throwable) {
        Log.w(TAG, "registerPhoneAccount failed: ${t.message}")
        false
      }
    }

    /**
     * Stable handle for our self-managed account. Re-derived from the
     * application context so callers don't need to plumb anything through.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    fun phoneAccountHandle(ctx: Context): PhoneAccountHandle {
      val cn = ComponentName(ctx, ChatyyInCallService::class.java)
      return PhoneAccountHandle(cn, ACCOUNT_ID)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // InCallService lifecycle
  //
  // The system binds us when there's at least one Call associated with our
  // PhoneAccountHandle. Until we ship the matching ConnectionService that
  // owns those Call objects, onCallAdded will likely never fire — the
  // stub still benefits us because the OS now recognises "Chatyy" as a
  // calling app (Settings → Calling Accounts, default-app picker, etc.).
  // ─────────────────────────────────────────────────────────────────────────

  override fun onCallAdded(call: Call) {
    super.onCallAdded(call)
    Log.d(TAG, "onCallAdded: details=${call.details?.handle}")
    // Future hook: subscribe to call.registerCallback(...) and bridge state
    // changes (HOLDING / DISCONNECTED / RINGING) into our IncomingCallActivity
    // / CallActivity flow. Today the legacy WS path drives those activities
    // directly.
  }

  override fun onCallRemoved(call: Call) {
    super.onCallRemoved(call)
    Log.d(TAG, "onCallRemoved")
  }
}
