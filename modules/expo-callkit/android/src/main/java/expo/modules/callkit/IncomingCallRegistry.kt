package expo.modules.callkit

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telecom.DisconnectCause
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * [2026-10-06 android-incoming] IncomingCallRegistry — process-wide, call_id
 * keyed bookkeeping shared by the THREE inbound paths that used to run
 * blind to each other:
 *
 *   * FCM data push      → CallFirebaseMessagingService (incoming_call)
 *   * raw WS frame       → CallSignalWs.handleIncomingCallInvite
 *   * Telecom            → ChatyyConnectionService / ChatyyConnection
 *
 * Forensics of the 2026-10-06 duarte(iOS) → suporte(Android) missed call:
 * 2 FCM pushes + 2 WS invites landed 230ms apart for ONE call_id. The FCM
 * path had no dedupe at all → 2× CallRingingService.onStartCommand (two
 * 45s timers, vibrator restart) and 2× TelecomManager.addNewIncomingCall
 * (two RINGING ChatyyConnection for the same call). Meanwhile the app was
 * in FOREGROUND, so the system never fired the full-screen intent and the
 * WS path `return`ed early ("JS owns the UI") — JS has no listener. Net
 * result: ringtone + LiveKit preconnect, zero answerable surface, missed
 * after 45s, and Telecom left holding a zombie RINGING Connection (the
 * client half of the hub's "busy zumbi").
 *
 * What lives here:
 *   1. `markInviteSeen` — one 60s TTL seen-set for FCM + WS (replaces the
 *      WS-only `seenIncomingInvites`).
 *   2. `markTelecomRequested` — one addNewIncomingCall per call_id.
 *   3. `registerConnection` / `answerTelecom` / `endTelecom` — lets OUR UI
 *      (IncomingCallActivity, CallActionReceiver, CallRingingService
 *      timeout, WS/FCM cancel, CallActivity hangup) drive the Telecom
 *      Connection lifecycle so it never stays RINGING/ACTIVE orphaned.
 *   4. `launchRingingUiIfForeground` — the missing foreground surface:
 *      start IncomingCallActivity directly when the app is in front (the
 *      OS only honours setFullScreenIntent when the device is locked /
 *      screen off). Background/locked path is untouched — the FSI still
 *      owns it.
 *
 * Everything is best-effort and never throws into the caller.
 */
object IncomingCallRegistry {
    private const val TAG = "IncomingCallRegistry"

    /** Seen-set TTL. Ring is 45s (CallRingingService.RINGING_TIMEOUT_MS)
     *  + slack so a late duplicate push for an already-missed call doesn't
     *  re-ring, but a brand-new call reusing nothing is never blocked. */
    private const val SEEN_TTL_MS = 60_000L

    /** call_id → first-seen epoch millis. */
    private val seenAt = ConcurrentHashMap<String, Long>()
    /** call_id → comma-joined sources that already surfaced it ("fcm", "ws"). */
    private val seenSources = ConcurrentHashMap<String, String>()
    /** call_id → epoch millis when addNewIncomingCall was dispatched. */
    private val telecomRequestedAt = ConcurrentHashMap<String, Long>()
    /** call_id → epoch millis when we launched IncomingCallActivity directly. */
    private val uiLaunchedAt = ConcurrentHashMap<String, Long>()
    /** call_id → live Telecom Connection (incoming OR outgoing). Registered in
     *  ChatyyConnectionService.onCreate*Connection, dropped on destroy. */
    private val connections = ConcurrentHashMap<String, ChatyyConnection>()

    private val mainHandler = Handler(Looper.getMainLooper())

    // ───────────────────────── seen-set (FCM + WS) ─────────────────────────

    /**
     * Returns true when this (call_id, source) pair is NEW — i.e. the caller
     * should proceed. Returns false when the SAME source already surfaced
     * this call within the TTL (true duplicate: skip everything).
     *
     * A different source for an already-seen call returns true as well —
     * callers then consult [isRinging] to avoid a second
     * startForegroundService while still being allowed to add what the first
     * source lacked (FCM carries lk creds + avatar; WS does not).
     */
    fun markInviteSeen(callId: String, source: String): Boolean {
        if (callId.isEmpty()) return true
        sweep()
        val now = System.currentTimeMillis()
        val first = seenAt.putIfAbsent(callId, now)
        val prev = seenSources[callId] ?: ""
        val already = prev.split(',').any { it == source }
        if (already) {
            Log.d(TAG, "markInviteSeen $callId source=$source: duplicate (sources=$prev, age=${now - (first ?: now)}ms)")
            return false
        }
        seenSources[callId] = if (prev.isEmpty()) source else "$prev,$source"
        Log.d(TAG, "markInviteSeen $callId source=$source: new (sources=${seenSources[callId]})")
        return true
    }

    /** True when any source surfaced this call within the TTL. */
    fun hasSeen(callId: String): Boolean {
        if (callId.isEmpty()) return false
        val at = seenAt[callId] ?: return false
        return System.currentTimeMillis() - at <= SEEN_TTL_MS
    }

    /**
     * True when the ring for this call is already live: either the FGS is
     * actually ringing it (authoritative) or a sibling source surfaced the
     * invite moments ago and the FGS start is still in flight.
     */
    fun isRinging(callId: String): Boolean {
        if (callId.isEmpty()) return false
        return CallRingingService.ringingCallIds.contains(callId) || hasSeen(callId)
    }

    /**
     * Forget a call (call_end / cancel / missed / declined). Mirrors the
     * pre-existing WS behaviour (`seenIncomingInvites.remove`) so a genuine
     * re-invite reusing the same call_id is not filtered out.
     */
    fun forget(callId: String) {
        if (callId.isEmpty()) return
        seenAt.remove(callId)
        seenSources.remove(callId)
        telecomRequestedAt.remove(callId)
        uiLaunchedAt.remove(callId)
    }

    // ───────────────────────── Telecom dedupe + lifecycle ─────────────────────────

    /** True when this is the FIRST addNewIncomingCall for the call (proceed). */
    fun markTelecomRequested(callId: String): Boolean {
        if (callId.isEmpty()) return true
        sweep()
        val prev = telecomRequestedAt.putIfAbsent(callId, System.currentTimeMillis())
        if (prev != null) {
            Log.d(TAG, "markTelecomRequested $callId: already dispatched ${System.currentTimeMillis() - prev}ms ago — skipping")
            return false
        }
        return true
    }

    fun registerConnection(callId: String, conn: ChatyyConnection) {
        if (callId.isEmpty()) return
        val prev = connections.put(callId, conn)
        if (prev != null && prev !== conn) {
            // Second Connection for the same call (the exact "2× RINGING"
            // the forensics showed). Telecom already created it, so the only
            // sane thing is to tear the OLD one down — the newest holds the
            // freshest extras.
            Log.w(TAG, "registerConnection $callId: replacing a prior live Connection — destroying the old one")
            mainHandler.post {
                try { prev.endFromUi(DisconnectCause.OTHER, "superseded_duplicate") } catch (_: Throwable) {}
            }
        }
        Log.d(TAG, "registerConnection $callId (live=${connections.size})")
        // addNewIncomingCall → onCreateIncomingConnection is async (hundreds
        // of ms). If the user already tapped Accept in that window, sync the
        // freshly created Connection to ACTIVE right away instead of leaving
        // it RINGING.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && ExpoCallKitModule.isCallAccepting(callId)) {
            Log.i(TAG, "registerConnection $callId: call already accepted by our UI — answerFromUi() now")
            mainHandler.post {
                try { conn.answerFromUi() } catch (_: Throwable) {}
            }
        }
    }

    fun unregisterConnection(callId: String, conn: ChatyyConnection) {
        if (callId.isEmpty()) return
        // Only drop if it's still OUR instance (a newer duplicate may own the slot).
        if (connections.remove(callId, conn)) {
            Log.d(TAG, "unregisterConnection $callId (live=${connections.size})")
        }
    }

    fun hasConnection(callId: String): Boolean = callId.isNotEmpty() && connections.containsKey(callId)

    /**
     * Our own Accept (IncomingCallActivity / notification action) answered
     * the call — tell Telecom so the Connection flips RINGING → ACTIVE and
     * the OS takes over audio focus / MODE_IN_COMMUNICATION. Does NOT run
     * ChatyyConnection.onAnswer (that would double-launch CallActivity +
     * double-fire call_answered); it only syncs Telecom state.
     */
    fun answerTelecom(callId: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val conn = connections[callId] ?: return
        mainHandler.post {
            try { conn.answerFromUi() } catch (t: Throwable) {
                Log.w(TAG, "answerTelecom $callId failed: ${t.message}")
            }
        }
    }

    /**
     * Our own decline / timeout / remote cancel / hangup ended the call —
     * disconnect + destroy the Telecom Connection so it never lingers
     * RINGING or ACTIVE. `cause` is a [DisconnectCause] constant.
     */
    fun endTelecom(callId: String, cause: Int, reason: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val conn = connections[callId] ?: return
        mainHandler.post {
            try { conn.endFromUi(cause, reason) } catch (t: Throwable) {
                Log.w(TAG, "endTelecom $callId failed: ${t.message}")
            }
        }
    }

    // ───────────────────────── foreground surface ─────────────────────────

    /**
     * Strict "user is looking at the app" check. Deliberately `==
     * IMPORTANCE_FOREGROUND` (100) and NOT `<= IMPORTANCE_VISIBLE` like the
     * older copies in CallFirebaseMessagingService / CallSignalWs: those
     * accept IMPORTANCE_FOREGROUND_SERVICE (125) too, which is true the
     * instant OUR OWN CallRingingService FGS starts — i.e. they report
     * "foreground" for a locked phone. The Expo lifecycle flag is checked
     * first; the process check is the race-proof complement for the first
     * ~500ms after a cold resume.
     */
    fun isAppForeground(ctx: Context): Boolean {
        if (ExpoCallKitModule.isAppForeground) return true
        return try {
            val am = ctx.applicationContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
                ?: return false
            val procs = am.runningAppProcesses ?: return false
            val myPkg = ctx.applicationContext.packageName
            procs.any {
                it.processName == myPkg &&
                    it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
            }
        } catch (t: Throwable) {
            Log.w(TAG, "isAppForeground check failed: ${t.message}")
            false
        }
    }

    /**
     * When the app is in the foreground the system does NOT launch the
     * notification's full-screen intent (it shows a heads-up instead), so
     * nothing answerable appears. Start IncomingCallActivity directly —
     * starting an Activity from a Service/WS thread is allowed while the
     * app has a visible window (BAL exemption), which is exactly this case.
     *
     * Same extras as the FSI intent built in
     * CallNotificationService.buildIncomingCallNotification. Deduped per
     * call_id (IncomingCallActivity is singleInstance anyway — a second
     * start only hits onNewIntent, which ignores non-auto_accept intents).
     * Skipped when the call is already in the accept flow (CallActivity is
     * — or is about to be — on screen for it).
     *
     * Returns true when we launched. Never throws. Background/locked path
     * is unaffected: we return false and the FSI keeps doing its job.
     */
    fun launchRingingUiIfForeground(
        ctx: Context,
        callId: String,
        callerName: String,
        callerEmail: String,
        conversationId: String,
        hasVideo: Boolean,
        callerAvatar: String = "",
        isGroup: Boolean = false,
        groupName: String = "",
        source: String = "?"
    ): Boolean {
        if (callId.isEmpty()) return false
        val app = ctx.applicationContext
        if (!isAppForeground(app)) {
            Log.d(TAG, "launchRingingUi $callId src=$source: app not foreground — FSI/notification owns the surface")
            return false
        }
        if (ExpoCallKitModule.isCallAccepting(callId) || ExpoCallKitModule.isCallAcceptingPersisted(app, callId)) {
            Log.d(TAG, "launchRingingUi $callId src=$source: already in accept flow — skipping")
            return false
        }
        sweep()
        val prev = uiLaunchedAt.putIfAbsent(callId, System.currentTimeMillis())
        if (prev != null) {
            Log.d(TAG, "launchRingingUi $callId src=$source: already launched ${System.currentTimeMillis() - prev}ms ago — skipping")
            return false
        }
        return try {
            val intent = Intent(app, IncomingCallActivity::class.java).apply {
                putExtra("call_id", callId)
                putExtra("caller_name", callerName)
                putExtra("caller_email", callerEmail)
                putExtra("conversation_id", conversationId)
                putExtra("has_video", hasVideo)
                putExtra("caller_avatar", callerAvatar)
                putExtra("is_group", isGroup)
                putExtra("group_name", groupName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            app.startActivity(intent)
            Log.i(TAG, "launchRingingUi $callId src=$source: IncomingCallActivity started directly (app foreground)")
            Log.i("CallTrace", "[6b/12] foreground ring surface launched callId=$callId src=$source ts=${System.currentTimeMillis()}")
            true
        } catch (t: Throwable) {
            // BAL denied / OEM quirk — the heads-up notification with
            // Atender/Recusar is still posted, so the call remains answerable.
            uiLaunchedAt.remove(callId)
            Log.w(TAG, "launchRingingUi $callId src=$source: startActivity failed: ${t.message}")
            false
        }
    }

    // ───────────────────────── internals ─────────────────────────

    /** Drop TTL-expired bookkeeping. Cheap (maps hold a handful of entries). */
    private fun sweep() {
        val now = System.currentTimeMillis()
        try {
            for ((id, at) in seenAt) {
                if (now - at > SEEN_TTL_MS) {
                    seenAt.remove(id)
                    seenSources.remove(id)
                }
            }
            for ((id, at) in telecomRequestedAt) {
                if (now - at > SEEN_TTL_MS) telecomRequestedAt.remove(id)
            }
            for ((id, at) in uiLaunchedAt) {
                if (now - at > SEEN_TTL_MS) uiLaunchedAt.remove(id)
            }
        } catch (_: Throwable) { /* best-effort */ }
    }
}
