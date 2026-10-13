package expo.modules.callkit

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.os.Build

/**
 * [2026-10-12 find-my] Recebe as atualizações PASSIVAS de localização
 * registradas por FriendLocationPinger.syncPassive (só existe com
 * ACCESS_BACKGROUND_LOCATION concedida — hoje dormente). POST fora da main
 * thread com goAsync().
 */
class FriendLocationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val loc: Location? = try {
            if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(LocationManager.KEY_LOCATION_CHANGED, Location::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra<Location>(LocationManager.KEY_LOCATION_CHANGED)
            }
        } catch (_: Throwable) { null }
        if (loc == null) return
        val app = context.applicationContext
        val pending = goAsync()
        Thread({
            try { FriendLocationPinger.onPassive(app, loc) } catch (_: Throwable) {}
            finally { try { pending.finish() } catch (_: Throwable) {} }
        }, "chatyy-friendloc").start()
    }
}
