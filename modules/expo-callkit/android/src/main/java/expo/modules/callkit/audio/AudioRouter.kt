// AudioRouter.kt — Wave B (Audio WhatsApp-grade), 2026-05-18
// [2026-10-15 viva-voz] Rewritten as the ONE owner of call audio routing.
//
// Bug (founder): "o viva-voz no Android não funciona". There were THREE
// writers of the route and they undid each other:
//   1. LiveKit's AudioSwitchHandler (com.twilio.audioswitch) — started on every
//      Room.connect; re-applies ITS selected device (setSpeakerphoneOn(false)
//      for Earpiece) on activate / device-scan / focus events → the loudspeaker
//      the user picked fell back to the earpiece a moment later.
//   2. This router — AudioManager.setSpeakerphoneOn only. On Android 12+
//      (API 31) that is deprecated and, when another client owns the
//      communication route (Telecom for our self-managed Connection = mode
//      owner on incoming calls), it is IGNORED (Pixel/Samsung).
//   3. Telecom (ChatyyConnection, self-managed) — owns the route of incoming
//      calls; its onCallAudioStateChanged called setSpeaker(route==SPEAKER),
//      i.e. it RE-APPLIED Telecom's earpiece over the user's choice.
//
// Now:
//   • LiveKit runs with NoAudioHandler for 1:1/group call Rooms
//     ([liveKitOverrides]) — no AudioSwitch.
//   • API 31+: AudioManager.setCommunicationDevice / getAvailableCommunication
//     Devices (BUILTIN_SPEAKER / BUILTIN_EARPIECE / BLUETOOTH_SCO|BLE / WIRED /
//     USB); < 31: setSpeakerphoneOn + startBluetoothSco.
//   • When a Telecom Connection is live, the route also goes through
//     Connection.setAudioRoute so Telecom agrees (it is the mode owner).
//   • Telecom / communication-device callbacks only SYNC the state (and re-assert
//     our choice if something stomps it right after we applied it).
//   • The user's choice wins over the automatic rules (camera, initial default)
//     until the user changes it again; a headset/BT connecting mid-call still
//     takes the route (WhatsApp behaviour).
//   • Listeners ([addListener]) get every real route change → the UI button
//     reflects the actual route, CallActivity gates proximity on EARPIECE.

package expo.modules.callkit.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKitOverrides
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.room.Room
import java.util.concurrent.CopyOnWriteArraySet

class AudioRouter private constructor(private val appContext: Context) {

    enum class Route { EARPIECE, SPEAKER, BLUETOOTH, WIRED;
        val wire: String get() = when (this) {
            EARPIECE -> "earpiece"; SPEAKER -> "speaker"; BLUETOOTH -> "bluetooth"; WIRED -> "wired"
        }
    }

    fun interface Listener { fun onRouteChanged(route: Route) }

    companion object {
        private const val TAG = "AudioRouter"
        /** Window after we applied a route in which a different observed route
         *  is treated as "someone stomped it" and re-asserted. */
        private const val REASSERT_WINDOW_MS = 2500L
        private const val MAX_REASSERTS = 3

        @Volatile private var instance: AudioRouter? = null

        @JvmStatic
        fun get(context: Context): AudioRouter {
            val existing = instance
            if (existing != null) return existing
            synchronized(this) {
                val again = instance
                if (again != null) return again
                val fresh = AudioRouter(context.applicationContext)
                instance = fresh
                return fresh
            }
        }

        /** [2026-10-15 viva-voz] LiveKit overrides for CALL rooms: no
         *  AudioSwitch — this router is the single owner of the route. */
        @JvmStatic
        fun liveKitOverrides(): LiveKitOverrides =
            LiveKitOverrides(audioOptions = AudioOptions(audioHandler = NoAudioHandler()))
    }

    private val am: AudioManager =
        appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<Listener>()

    @Volatile private var hasVideo: Boolean = false
    @Volatile private var active: Boolean = false
    @Volatile private var activeCallId: String = ""
    @Volatile private var diagCallId: String = ""

    /** Route we want (last decision). */
    @Volatile var desiredRoute: Route = Route.EARPIECE
        private set
    /** Route actually in effect (as observed). */
    @Volatile var currentRoute: Route = Route.EARPIECE
        private set
    /** True once the user picked an output by hand (wins over auto rules). */
    @Volatile var userPicked: Boolean = false
        private set

    val speakerOn: Boolean get() = currentRoute == Route.SPEAKER
    val routeName: String get() = currentRoute.wire

    private var lastApplyAt = 0L
    private var reasserts = 0

    private var deviceCallback: AudioDeviceCallback? = null
    private var commListener: Any? = null // AudioManager.OnCommunicationDeviceChangedListener (API 31+)

    private val focusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        Log.d(TAG, "onAudioFocusChange: change=$focusChange")
    }
    private var focusRequest: AudioFocusRequest? = null
    @Volatile private var focusHeld: Boolean = false

    // ───────────────────────── Public API

    fun addListener(l: Listener) { listeners.add(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }

    /** Kept for call sites: with [liveKitOverrides] there is no AudioSwitch,
     *  so this only records the call type. If a Room still carries an
     *  AudioSwitchHandler (legacy path), align it with our route. */
    fun attachLiveKit(room: Room?, hasVideo: Boolean) {
        val h = try { room?.audioSwitchHandler } catch (_: Throwable) { null }
        if (h != null) {
            Log.w(TAG, "attachLiveKit: Room has AudioSwitchHandler — create it with AudioRouter.liveKitOverrides()")
        }
        if (active && hasVideo && !this.hasVideo) {
            this.hasVideo = true
            if (!userPicked && !hasAnyExternalAudioDevice() && desiredRoute == Route.EARPIECE) {
                selectRoute(Route.SPEAKER, user = false, reason = "attach_video")
            }
        }
    }

    /**
     * Initial setup at call start. Pins MODE_IN_COMMUNICATION, claims audio
     * focus, picks the initial route (BT > wired > speaker for video /
     * earpiece for voice). Idempotent for the same call: a second call (warm
     * FGS path + CallActivity.onCreate) never resets the user's choice.
     */
    fun configureForCall(hasVideo: Boolean, callId: String = "") {
        val sameCall = active && (callId.isEmpty() || activeCallId.isEmpty() || callId == activeCallId)
        if (callId.isNotEmpty()) { activeCallId = callId; diagCallId = callId }
        try {
            if (am.mode != AudioManager.MODE_IN_COMMUNICATION) am.mode = AudioManager.MODE_IN_COMMUNICATION
        } catch (t: Throwable) {
            Log.w(TAG, "set MODE_IN_COMMUNICATION failed: ${t.message}")
        }
        requestVoiceCallFocus()
        installListenersIfNeeded()
        if (sameCall) {
            if (hasVideo && !this.hasVideo) attachLiveKit(null, true)
            else if (userPicked) applyRoute(desiredRoute, "reconfigure")
            Log.d(TAG, "configureForCall(same call) hasVideo=$hasVideo route=$desiredRoute user=$userPicked")
            return
        }
        active = true
        userPicked = false
        reasserts = 0
        this.hasVideo = hasVideo
        val initial = defaultRoute()
        selectRoute(initial, user = false, reason = "initial")
    }

    /** Toggle the speaker. Returns the new speaker-on state. */
    fun toggleSpeaker(): Boolean = setSpeaker(!speakerOn)

    /** Wired / BT output connected (the camera-on loudspeaker rule must not
     *  steal the route from a headset). */
    fun hasExternalOutput(): Boolean = hasAnyExternalAudioDevice()

    /** User/explicit speaker on/off. Off → BT > wired > earpiece. */
    fun setSpeaker(on: Boolean): Boolean {
        val r = if (on) Route.SPEAKER else bestNonSpeaker()
        selectRoute(r, user = true, reason = "set_speaker")
        return on
    }

    /** Automatic rule (camera on/off). Never overrides a user choice. */
    fun setSpeakerAuto(on: Boolean, reason: String): Boolean {
        if (userPicked) return speakerOn
        if (hasAnyExternalAudioDevice()) return speakerOn
        selectRoute(if (on) Route.SPEAKER else Route.EARPIECE, user = false, reason = reason)
        return on
    }

    /** Force-route through Bluetooth (HFP/LE) if available. */
    fun preferBluetooth() {
        if (!hasAnyBluetoothDevice()) return
        selectRoute(Route.BLUETOOTH, user = true, reason = "prefer_bt")
    }

    /** Route picked from the output sheet ("earpiece"/"speaker"/"bluetooth"/"wired"). */
    fun selectRouteByName(name: String) {
        val r = when (name) {
            "speaker" -> Route.SPEAKER
            "bluetooth" -> Route.BLUETOOTH
            "wired" -> Route.WIRED
            else -> Route.EARPIECE
        }
        selectRoute(r, user = true, reason = "picker")
    }

    fun selectRoute(route: Route, user: Boolean, reason: String) {
        if (user) userPicked = true
        desiredRoute = route
        reasserts = 0
        applyRoute(route, reason)
    }

    /**
     * Telecom (self-managed ChatyyConnection) reported its route. SYNC only —
     * if it differs from what we just applied, re-assert ours (bounded);
     * otherwise adopt it (system output switcher / Android Auto / BT key).
     */
    fun onTelecomRoute(telecomRoute: Int) {
        val r = when (telecomRoute) {
            android.telecom.CallAudioState.ROUTE_SPEAKER -> Route.SPEAKER
            android.telecom.CallAudioState.ROUTE_BLUETOOTH -> Route.BLUETOOTH
            android.telecom.CallAudioState.ROUTE_WIRED_HEADSET -> Route.WIRED
            else -> Route.EARPIECE
        }
        handler.post { reconcile(r, "telecom") }
    }

    /** Telecom Connection just went ACTIVE (it now owns the route and resets
     *  it to its own default) → push our desired route to it. */
    fun onTelecomActive() {
        handler.post {
            if (!active) return@post
            lastApplyAt = System.currentTimeMillis()
            reasserts = 0
            applyRoute(desiredRoute, "telecom_active")
        }
    }

    /** End-of-call cleanup. */
    fun teardown() {
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice()
            }
        } catch (_: Throwable) {}
        try {
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            @Suppress("DEPRECATION")
            am.stopBluetoothSco()
        } catch (_: Throwable) {}
        try {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
        } catch (_: Throwable) {}
        try { am.mode = AudioManager.MODE_NORMAL } catch (_: Throwable) {}
        abandonVoiceCallFocus()

        val cb = deviceCallback
        if (cb != null) {
            try { am.unregisterAudioDeviceCallback(cb) } catch (_: Throwable) {}
        }
        deviceCallback = null
        if (Build.VERSION.SDK_INT >= 31) {
            val l = commListener
            if (l is AudioManager.OnCommunicationDeviceChangedListener) {
                try { am.removeOnCommunicationDeviceChangedListener(l) } catch (_: Throwable) {}
            }
        }
        commListener = null
        hasVideo = false
        active = false
        activeCallId = ""
        userPicked = false
        desiredRoute = Route.EARPIECE
        currentRoute = Route.EARPIECE
        reasserts = 0
        Log.d(TAG, "teardown")
    }

    // ───────────────────────── Routing internals

    private fun defaultRoute(): Route = when {
        hasAnyBluetoothDevice() -> Route.BLUETOOTH
        hasWiredDevice() -> Route.WIRED
        hasVideo -> Route.SPEAKER
        else -> Route.EARPIECE
    }

    private fun bestNonSpeaker(): Route = when {
        hasAnyBluetoothDevice() -> Route.BLUETOOTH
        hasWiredDevice() -> Route.WIRED
        else -> Route.EARPIECE
    }

    private fun applyRoute(route: Route, reason: String) {
        lastApplyAt = System.currentTimeMillis()
        var applied = false
        try {
            if (active && am.mode != AudioManager.MODE_IN_COMMUNICATION) {
                am.mode = AudioManager.MODE_IN_COMMUNICATION
            }
        } catch (_: Throwable) {}
        // 1) Telecom (when our self-managed Connection is live it owns the route).
        val telecomOk = applyTelecomRoute(route)
        // 2) AudioManager.
        if (Build.VERSION.SDK_INT >= 31) {
            applied = applyCommunicationDevice(route)
        } else {
            applied = applyLegacy(route)
        }
        Log.i(TAG, "applyRoute $route reason=$reason applied=$applied telecom=$telecomOk")
        diag("audio_route_set", "route=${route.wire} reason=$reason user=$userPicked applied=$applied telecom=$telecomOk sdk=${Build.VERSION.SDK_INT}")
        // Read back what is really in effect (setCommunicationDevice is sync
        // for the request; the listener corrects us later if it changes).
        handler.postDelayed({ reconcile(observeRoute(), "readback") }, 350L)
        if (applied && observeRoute() == route) setCurrent(route)
    }

    private fun applyTelecomRoute(route: Route): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val conn = try { expo.modules.callkit.IncomingCallRegistry.activeTelecomConnection() } catch (_: Throwable) { null }
            ?: return false
        val tr = when (route) {
            Route.SPEAKER -> android.telecom.CallAudioState.ROUTE_SPEAKER
            Route.BLUETOOTH -> android.telecom.CallAudioState.ROUTE_BLUETOOTH
            Route.WIRED -> android.telecom.CallAudioState.ROUTE_WIRED_HEADSET
            Route.EARPIECE -> android.telecom.CallAudioState.ROUTE_EARPIECE
        }
        return try {
            @Suppress("DEPRECATION")
            conn.setAudioRoute(tr)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "telecom setAudioRoute failed: ${t.message}")
            false
        }
    }

    private fun applyCommunicationDevice(route: Route): Boolean {
        if (Build.VERSION.SDK_INT < 31) return false
        return try {
            val devs = am.availableCommunicationDevices
            val target: AudioDeviceInfo? = when (route) {
                Route.SPEAKER -> devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                Route.EARPIECE -> devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    ?: devs.firstOrNull { isWiredType(it.type) }
                Route.BLUETOOTH -> devs.firstOrNull { isBtCommType(it.type) }
                Route.WIRED -> devs.firstOrNull { isWiredType(it.type) }
                    ?: devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
            }
            if (target == null) {
                Log.w(TAG, "no communication device for $route (avail=${devs.joinToString { it.type.toString() }})")
                if (route == Route.EARPIECE) { am.clearCommunicationDevice(); true } else false
            } else {
                val ok = am.setCommunicationDevice(target)
                if (!ok) Log.w(TAG, "setCommunicationDevice($route type=${target.type}) returned false")
                ok
            }
        } catch (t: Throwable) {
            Log.w(TAG, "applyCommunicationDevice($route) failed: ${t.message}")
            false
        }
    }

    @Suppress("DEPRECATION")
    private fun applyLegacy(route: Route): Boolean {
        return try {
            when (route) {
                Route.SPEAKER -> {
                    am.isBluetoothScoOn = false
                    am.stopBluetoothSco()
                    am.isSpeakerphoneOn = true
                }
                Route.BLUETOOTH -> {
                    am.isSpeakerphoneOn = false
                    am.startBluetoothSco()
                    am.isBluetoothScoOn = true
                }
                Route.EARPIECE, Route.WIRED -> {
                    am.isBluetoothScoOn = false
                    am.stopBluetoothSco()
                    am.isSpeakerphoneOn = false
                }
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "applyLegacy($route) failed: ${t.message}")
            false
        }
    }

    /** Route really in effect right now. */
    private fun observeRoute(): Route {
        if (Build.VERSION.SDK_INT >= 31) {
            val d = try { am.communicationDevice } catch (_: Throwable) { null }
            if (d != null) return routeForType(d.type)
        }
        @Suppress("DEPRECATION")
        return when {
            am.isSpeakerphoneOn -> Route.SPEAKER
            am.isBluetoothScoOn -> Route.BLUETOOTH
            hasWiredDevice() -> Route.WIRED
            else -> Route.EARPIECE
        }
    }

    private fun matches(observed: Route, desired: Route): Boolean =
        observed == desired ||
            // earpiece request with a wired headset plugged → the system uses the headset.
            (desired == Route.EARPIECE && observed == Route.WIRED) ||
            (desired == Route.WIRED && observed == Route.EARPIECE && !hasWiredDevice()) ||
            // < API 31: SCO connects asynchronously (~1 s) after startBluetoothSco.
            (desired == Route.BLUETOOTH && Build.VERSION.SDK_INT < 31 && observed == Route.EARPIECE && hasAnyBluetoothDevice())

    /** Main thread. Observed route vs desired: re-assert a stomp right after
     *  we applied, else adopt (external change). */
    private fun reconcile(observed: Route, source: String) {
        if (!active) return
        if (matches(observed, desiredRoute)) {
            reasserts = 0
            setCurrent(if (desiredRoute == Route.BLUETOOTH) Route.BLUETOOTH else observed)
            return
        }
        val sinceApply = System.currentTimeMillis() - lastApplyAt
        val desiredAvailable = when (desiredRoute) {
            Route.BLUETOOTH -> hasAnyBluetoothDevice()
            Route.WIRED -> hasWiredDevice()
            else -> true
        }
        if (desiredAvailable && sinceApply < REASSERT_WINDOW_MS && reasserts < MAX_REASSERTS) {
            reasserts++
            Log.w(TAG, "reconcile($source): observed=$observed desired=$desiredRoute — re-assert #$reasserts")
            diag("audio_route_reassert", "src=$source observed=${observed.wire} desired=${desiredRoute.wire} n=$reasserts")
            val keep = lastApplyAt
            applyRoute(desiredRoute, "reassert_$source")
            lastApplyAt = keep // the window is anchored to the ORIGINAL decision
            return
        }
        // External change (system output switcher, Telecom fallback, device gone).
        Log.i(TAG, "reconcile($source): adopting observed=$observed (desired was $desiredRoute)")
        diag("audio_route_adopt", "src=$source observed=${observed.wire} desired=${desiredRoute.wire}")
        desiredRoute = observed
        setCurrent(observed)
    }

    private fun setCurrent(r: Route) {
        val changed = currentRoute != r
        currentRoute = r
        if (changed) {
            try { expo.modules.callkit.CurrentCallTracker.setSpeaker(r == Route.SPEAKER) } catch (_: Throwable) {}
        }
        // Always notify (cheap): the UI may hold a stale optimistic value.
        handler.post { listeners.forEach { l -> try { l.onRouteChanged(r) } catch (_: Throwable) {} } }
    }

    private fun installListenersIfNeeded() {
        if (deviceCallback == null) {
            val cb = object : AudioDeviceCallback() {
                override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
                    val added = addedDevices ?: return
                    if (!active) return
                    val bt = added.any { isBluetoothDevice(it) }
                    val wired = added.any { isWiredType(it.type) }
                    if (!bt && !wired) return
                    Log.d(TAG, "onAudioDevicesAdded bt=$bt wired=$wired")
                    // A headset connecting mid-call takes the route (WhatsApp).
                    selectRoute(if (bt) Route.BLUETOOTH else Route.WIRED, user = false, reason = "device_added")
                }

                override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                    val removed = removedDevices ?: return
                    if (!active) return
                    if (!removed.any { isExternalDevice(it) }) return
                    val stillOk = when (desiredRoute) {
                        Route.BLUETOOTH -> hasAnyBluetoothDevice()
                        Route.WIRED -> hasWiredDevice()
                        else -> true
                    }
                    if (stillOk) return
                    Log.d(TAG, "onAudioDevicesRemoved — $desiredRoute gone, fallback")
                    val fb = when {
                        hasAnyBluetoothDevice() -> Route.BLUETOOTH
                        hasWiredDevice() -> Route.WIRED
                        hasVideo -> Route.SPEAKER
                        else -> Route.EARPIECE
                    }
                    selectRoute(fb, user = false, reason = "device_removed")
                }
            }
            try {
                am.registerAudioDeviceCallback(cb, handler)
                deviceCallback = cb
            } catch (t: Throwable) {
                Log.w(TAG, "registerAudioDeviceCallback failed: ${t.message}")
            }
        }
        if (Build.VERSION.SDK_INT >= 31 && commListener == null) {
            try {
                val l = AudioManager.OnCommunicationDeviceChangedListener { dev ->
                    val r = if (dev != null) routeForType(dev.type) else Route.EARPIECE
                    handler.post { reconcile(r, "comm_device") }
                }
                am.addOnCommunicationDeviceChangedListener({ cmd -> handler.post(cmd) }, l)
                commListener = l
            } catch (t: Throwable) {
                Log.w(TAG, "addOnCommunicationDeviceChangedListener failed: ${t.message}")
            }
        }
    }

    private fun requestVoiceCallFocus() {
        if (focusHeld) return
        try {
            val result: Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(focusListener, handler)
                    .setAcceptsDelayedFocusGain(true)
                    .build()
                focusRequest = req
                am.requestAudioFocus(req)
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(
                    focusListener,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                )
            }
            focusHeld = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED ||
                         result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED)
            Log.d(TAG, "requestAudioFocus result=$result held=$focusHeld")
        } catch (t: Throwable) {
            Log.w(TAG, "requestAudioFocus failed: ${t.message}")
        }
    }

    private fun abandonVoiceCallFocus() {
        if (!focusHeld) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(focusListener)
            }
            Log.d(TAG, "abandonAudioFocus")
        } catch (t: Throwable) {
            Log.w(TAG, "abandonAudioFocus failed: ${t.message}")
        } finally {
            focusHeld = false
            focusRequest = null
        }
    }

    private fun diag(event: String, detail: String) {
        try { expo.modules.callkit.CallDiag.log(event, diagCallId, detail, appContext) } catch (_: Throwable) {}
    }

    // ───────────────────────── Device-type helpers

    private fun outputs(): Array<AudioDeviceInfo> =
        try { am.getDevices(AudioManager.GET_DEVICES_OUTPUTS) } catch (_: Throwable) { emptyArray() }

    private fun hasAnyExternalAudioDevice(): Boolean = outputs().any { isExternalDevice(it) }

    private fun hasAnyBluetoothDevice(): Boolean {
        if (Build.VERSION.SDK_INT >= 31) {
            val comm = try { am.availableCommunicationDevices } catch (_: Throwable) { null }
            if (comm != null) return comm.any { isBtCommType(it.type) }
        }
        return outputs().any { isBluetoothDevice(it) }
    }

    private fun hasWiredDevice(): Boolean = outputs().any { isWiredType(it.type) }

    private fun routeForType(type: Int): Route = when {
        type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> Route.SPEAKER
        isBtCommType(type) || type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> Route.BLUETOOTH
        isWiredType(type) -> Route.WIRED
        else -> Route.EARPIECE
    }

    private fun isBtCommType(type: Int): Boolean = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_HEARING_AID,
        26 /* TYPE_BLE_HEADSET */,
        27 /* TYPE_BLE_SPEAKER */ -> true
        else -> false
    }

    private fun isWiredType(type: Int): Boolean = when (type) {
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_ACCESSORY -> true
        else -> false
    }

    private fun isBluetoothDevice(d: AudioDeviceInfo): Boolean =
        isBtCommType(d.type) || d.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP

    private fun isExternalDevice(d: AudioDeviceInfo): Boolean =
        isBluetoothDevice(d) || isWiredType(d.type)
}
