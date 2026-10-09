// CallTelecomBridge.kt — [2026-10-09 system-integration] Telecom → CallActivity
// in-process broadcast contract. ChatyyConnection (Telecom callbacks: hold by
// a GSM call / Auto / Wear, system mute) sends ACTION_TELECOM_STATE with
// package-scoped intents; CallActivity applies them to its LiveKit Room + UI.
//
// Extras (all optional except call_id):
//   call_id : String   — the Chatyy call id (receiver ignores other calls)
//   held    : Boolean  — Telecom put the call on hold (true) / resumed (false)
//   muted   : Boolean  — mute toggled outside the app (Auto / Wear / headset)

package expo.modules.callkit

object CallTelecomBridge {
  const val ACTION_TELECOM_STATE = "expo.modules.callkit.TELECOM_STATE"

  /**
   * Extras for the self-managed PhoneAccount (API 29+ / 30+):
   *  - EXTRA_LOG_SELF_MANAGED_CALLS: calls show up in the system call log
   *    (Phone app "Recentes"), attributed to Chatyy — the Android side of
   *    iOS includesCallsInRecents.
   *  - EXTRA_ADD_SELF_MANAGED_CALLS_TO_INCALLSERVICE: Android Auto / Wear /
   *    car head units (InCallServices that opt in) see and control our calls.
   */
  @JvmStatic
  fun phoneAccountExtras(): android.os.Bundle {
    val b = android.os.Bundle()
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
      b.putBoolean(android.telecom.PhoneAccount.EXTRA_LOG_SELF_MANAGED_CALLS, true)
    }
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
      b.putBoolean(android.telecom.PhoneAccount.EXTRA_ADD_SELF_MANAGED_CALLS_TO_INCALLSERVICE, true)
    }
    return b
  }
}
