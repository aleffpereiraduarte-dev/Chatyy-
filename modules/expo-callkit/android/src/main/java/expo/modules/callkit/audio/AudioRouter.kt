// AudioRouter.kt — Wave B (Audio WhatsApp-grade), 2026-05-18
//
// Central helper that owns AudioManager during a native call. Mirrors the
// iOS AudioRouter API. Replaces the ad-hoc applyAudioRoute() block in
// CallActivity so audio/video calls have consistent routing + mid-call BT
// handling.
//
// Policy:
//   • Audio call -> earpiece by default; speaker via explicit toggle.
//   • Video call -> speaker by default.
//   • Wired headset / BT headset present at start -> route to it (skip the
//                    initial default).
//   • BT connect mid-call  -> re-route to BT.
//   • BT disconnect mid-call -> fall back to call default (speaker if video,
//                                earpiece if audio).
//
// Note: AudioDeviceCallback is API 23+ (we target 26+). Builds before 23
// will silently lose the mid-call BT re-route — UI toggle still works.

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

class AudioRouter private constructor(private val appContext: Context) {

    companion object {
        private const val TAG = "AudioRouter"

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
    }

    private val am: AudioManager =
        appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())

    @Volatile private var hasVideo: Boolean = false
    @Volatile var speakerOn: Boolean = false
        private set

    private var deviceCallback: AudioDeviceCallback? = null

    // [#1201 audio fix, 2026-05-19] Real audio focus listener + request handle.
    // Replaces the leaked `requestAudioFocus(null, …)` that IncomingCallActivity.onAccept
    // used to fire pre-pre-warm — that call could never be abandoned (no listener
    // to match) and on the iOS→Android receive path it shadowed WebRTC's internal
    // ADM focus request once playback started, manifesting as "Android receives
    // call, says Conectado, but no remote voice plays" while the reverse direction
    // (Android→iOS = Android never visits IncomingCallActivity = clean focus) worked.
    private val focusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        // Log only — we don't want LK's audio publish/playback to flap on
        // transient focus loss/gain. The peer-side speaker volume bouncing
        // is way worse than tolerating a momentary other-app blip.
        Log.d(TAG, "onAudioFocusChange: change=$focusChange")
    }
    private var focusRequest: AudioFocusRequest? = null
    @Volatile private var focusHeld: Boolean = false

    // ───────────────────────── Public API

    /**
     * Initial setup at call start. Pins MODE_IN_COMMUNICATION, claims audio
     * focus (STREAM_VOICE_CALL), picks the initial route (speaker for video,
     * earpiece for audio, override to BT if connected). Idempotent.
     */
    fun configureForCall(hasVideo: Boolean) {
        this.hasVideo = hasVideo
        this.speakerOn = hasVideo

        try {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
        } catch (t: Throwable) {
            Log.w(TAG, "set MODE_IN_COMMUNICATION failed: ${t.message}")
        }

        // [#1201 audio fix] Claim audio focus with a real listener BEFORE LK
        // initializes its AudioDeviceModule. This gives WebRTC's internal
        // focus dance a stable parent to coexist with — and lets us
        // properly abandonAudioFocus(listener) in teardown() so the next
        // foreground app inherits a clean AudioManager state.
        requestVoiceCallFocus()

        applyInitialRoute()
        installDeviceCallbackIfNeeded()
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

    /**
     * Toggle the speaker. Returns the new speaker-on state.
     */
    fun toggleSpeaker(): Boolean = setSpeaker(!speakerOn)

    /**
     * Explicit setter. Returns the new state.
     */
    fun setSpeaker(on: Boolean): Boolean {
        speakerOn = on
        try {
            am.isSpeakerphoneOn = on
            if (on) {
                @Suppress("DEPRECATION")
                am.isBluetoothScoOn = false
                @Suppress("DEPRECATION")
                am.stopBluetoothSco()
            }
            Log.d(TAG, "speaker → $on")
        } catch (t: Throwable) {
            Log.w(TAG, "setSpeaker($on) failed: ${t.message}")
        }
        return on
    }

    /**
     * Force-route through Bluetooth SCO (HFP) if available. CallActivity uses
     * this via the long-press picker. No-op if no BT device.
     */
    fun preferBluetooth() {
        if (!hasAnyBluetoothDevice()) return
        try {
            am.isSpeakerphoneOn = false
            @Suppress("DEPRECATION")
            am.startBluetoothSco()
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = true
            speakerOn = false
            Log.d(TAG, "preferBluetooth: SCO requested")
        } catch (t: Throwable) {
            Log.w(TAG, "preferBluetooth failed: ${t.message}")
        }
    }

    /**
     * End-of-call cleanup. Abandons audio focus, drops MODE_IN_COMMUNICATION,
     * tears down the BT device callback. Speakerphone is reset off.
     */
    fun teardown() {
        try {
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            @Suppress("DEPRECATION")
            am.stopBluetoothSco()
        } catch (_: Throwable) {}
        try { am.isSpeakerphoneOn = false } catch (_: Throwable) {}
        try { am.mode = AudioManager.MODE_NORMAL } catch (_: Throwable) {}
        // [#1201 audio fix] Release focus so the next foreground app sees
        // a clean STREAM_VOICE_CALL handle. Doing this AFTER setting mode
        // back to NORMAL matches the Android sample call apps.
        abandonVoiceCallFocus()

        val cb = deviceCallback
        if (cb != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try { am.unregisterAudioDeviceCallback(cb) } catch (_: Throwable) {}
        }
        deviceCallback = null
        hasVideo = false
        speakerOn = false
        Log.d(TAG, "teardown")
    }

    // ───────────────────────── Routing internals

    private fun applyInitialRoute() {
        // If a wired / BT headset is currently connected, route through it
        // and skip the default. Same behaviour as the iOS path.
        if (hasAnyExternalAudioDevice()) {
            try {
                am.isSpeakerphoneOn = false
            } catch (_: Throwable) {}
            speakerOn = false
            // If BT specifically, prefer SCO so mic input also routes there.
            if (hasAnyBluetoothDevice()) {
                preferBluetooth()
            }
            Log.d(TAG, "initial route — external device present, leaving alone")
            return
        }
        // No external device — apply default policy.
        val wantSpeaker = hasVideo
        try {
            am.isSpeakerphoneOn = wantSpeaker
            speakerOn = wantSpeaker
            Log.d(TAG, "initial route → ${if (wantSpeaker) "speaker" else "earpiece"}")
        } catch (t: Throwable) {
            Log.w(TAG, "initial speakerphone set failed: ${t.message}")
        }
    }

    private fun installDeviceCallbackIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (deviceCallback != null) return
        val cb = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
                val added = addedDevices ?: return
                val newExternal = added.any { isExternalDevice(it) }
                if (!newExternal) return
                Log.d(TAG, "onAudioDevicesAdded — external device joined")
                // Re-route to it: clear speakerphone; for BT specifically,
                // request SCO so mic + earpiece both ride the headset.
                try { am.isSpeakerphoneOn = false } catch (_: Throwable) {}
                speakerOn = false
                if (added.any { isBluetoothDevice(it) }) {
                    preferBluetooth()
                }
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                val removed = removedDevices ?: return
                val externalGone = removed.any { isExternalDevice(it) }
                if (!externalGone) return
                Log.d(TAG, "onAudioDevicesRemoved — external device left")
                // If another external device is still connected, leave it.
                if (hasAnyExternalAudioDevice()) {
                    Log.d(TAG, "  another external device still present — no fallback")
                    return
                }
                // Otherwise: drop SCO, fall back to call default.
                try {
                    @Suppress("DEPRECATION")
                    am.isBluetoothScoOn = false
                    @Suppress("DEPRECATION")
                    am.stopBluetoothSco()
                } catch (_: Throwable) {}
                val wantSpeaker = hasVideo
                try {
                    am.isSpeakerphoneOn = wantSpeaker
                    speakerOn = wantSpeaker
                    Log.d(TAG, "  fallback → ${if (wantSpeaker) "speaker" else "earpiece"}")
                } catch (t: Throwable) {
                    Log.w(TAG, "fallback speakerphone set failed: ${t.message}")
                }
            }
        }
        try {
            am.registerAudioDeviceCallback(cb, handler)
            deviceCallback = cb
        } catch (t: Throwable) {
            Log.w(TAG, "registerAudioDeviceCallback failed: ${t.message}")
        }
    }

    // ───────────────────────── Device-type helpers

    private fun hasAnyExternalAudioDevice(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        val devices = try {
            am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        } catch (_: Throwable) { return false }
        return devices.any { isExternalDevice(it) }
    }

    private fun hasAnyBluetoothDevice(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
        val devices = try {
            am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        } catch (_: Throwable) { return false }
        return devices.any { isBluetoothDevice(it) }
    }

    private fun isBluetoothDevice(d: AudioDeviceInfo): Boolean {
        return when (d.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> true
            else -> false
        }
    }

    private fun isExternalDevice(d: AudioDeviceInfo): Boolean {
        return when (d.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_ACCESSORY,
            AudioDeviceInfo.TYPE_HEARING_AID -> true
            else -> false
        }
    }
}
