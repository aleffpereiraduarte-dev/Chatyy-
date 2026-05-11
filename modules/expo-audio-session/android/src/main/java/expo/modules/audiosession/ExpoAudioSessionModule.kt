package expo.modules.audiosession

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ExpoAudioSessionModule — Android counterpart of the iOS AVAudioSession bridge.
 *
 * Mirrors the iOS API so call.js can call the same methods on both platforms.
 * On Android the equivalent of AVAudioSession is AudioManager — we set the
 * audio mode (IN_COMMUNICATION for VoIP, RINGTONE for ringtone), toggle
 * speakerphone, and acquire a proximity wake lock during audio calls so the
 * screen blanks when held to the ear (WhatsApp / native Phone app behavior).
 *
 * Lifecycle, in order:
 *   1. Incoming → activateForRingtone() (MODE_RINGTONE — respects ringer settings)
 *   2. Accepted → activateForCall(useSpeaker) (MODE_IN_COMMUNICATION + audio focus)
 *   3. Toggle  → setSpeaker(enabled) (AudioManager.setSpeakerphoneOn)
 *   4. End     → deactivate() (MODE_NORMAL + release focus + release proximity lock)
 */
class ExpoAudioSessionModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  private val audioManager: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val powerManager: PowerManager
    get() = context.getSystemService(Context.POWER_SERVICE) as PowerManager

  // Track previous mode so deactivate() can restore the device to a clean state
  // even if another component changed it mid-call.
  @Volatile private var previousMode: Int = AudioManager.MODE_NORMAL

  // Audio focus request handle (API 26+) — kept so we can release it cleanly.
  @Volatile private var focusRequest: AudioFocusRequest? = null

  // Proximity wake lock — held while in an audio (non-video) call. Released
  // either via enableProximitySensor(false) or implicitly by deactivate().
  @Volatile private var proximityLock: PowerManager.WakeLock? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoAudioSession")

    AsyncFunction("activateForCall") { useSpeaker: Boolean ->
      synchronized(this@ExpoAudioSessionModule) {
        try {
          val am = audioManager
          previousMode = am.mode
          requestVoipFocus(am)
          am.mode = AudioManager.MODE_IN_COMMUNICATION
          am.isSpeakerphoneOn = useSpeaker
          // Don't force mic mute — WebRTC manages its own mic state.
          am.isMicrophoneMute = false
          true
        } catch (t: Throwable) {
          android.util.Log.w("AudioSession", "activateForCall failed: ${t.message}")
          false
        }
      }
    }

    AsyncFunction("activateForVideoCall") {
      synchronized(this@ExpoAudioSessionModule) {
        try {
          val am = audioManager
          previousMode = am.mode
          requestVoipFocus(am)
          am.mode = AudioManager.MODE_IN_COMMUNICATION
          am.isSpeakerphoneOn = true
          am.isMicrophoneMute = false
          true
        } catch (t: Throwable) {
          android.util.Log.w("AudioSession", "activateForVideoCall failed: ${t.message}")
          false
        }
      }
    }

    AsyncFunction("setSpeaker") { enabled: Boolean ->
      try {
        audioManager.isSpeakerphoneOn = enabled
        true
      } catch (t: Throwable) {
        android.util.Log.w("AudioSession", "setSpeaker failed: ${t.message}")
        false
      }
    }

    AsyncFunction("deactivate") {
      synchronized(this@ExpoAudioSessionModule) {
        try {
          releaseProximityLock()
          val am = audioManager
          am.isSpeakerphoneOn = false
          am.mode = previousMode.coerceAtLeast(AudioManager.MODE_NORMAL)
          abandonVoipFocus(am)
          true
        } catch (t: Throwable) {
          android.util.Log.w("AudioSession", "deactivate failed: ${t.message}")
          false
        }
      }
    }

    AsyncFunction("activateForRingtone") {
      try {
        audioManager.mode = AudioManager.MODE_RINGTONE
        true
      } catch (t: Throwable) {
        android.util.Log.w("AudioSession", "activateForRingtone failed: ${t.message}")
        false
      }
    }

    Function("getCurrentCategory") {
      try {
        val mode = audioManager.mode
        val name = when (mode) {
          AudioManager.MODE_NORMAL -> "normal"
          AudioManager.MODE_RINGTONE -> "ringtone"
          AudioManager.MODE_IN_CALL -> "in_call"
          AudioManager.MODE_IN_COMMUNICATION -> "in_communication"
          else -> "mode_$mode"
        }
        val speaker = if (audioManager.isSpeakerphoneOn) "speaker" else "earpiece"
        "$name / $speaker"
      } catch (t: Throwable) {
        "unknown"
      }
    }

    Function("isBluetoothConnectedSync") {
      try {
        val am = audioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          val devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
          devices.any {
            it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
              it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
          }
        } else {
          @Suppress("DEPRECATION")
          am.isBluetoothA2dpOn || am.isBluetoothScoOn
        }
      } catch (t: Throwable) {
        false
      }
    }

    Function("enableProximitySensor") { enabled: Boolean ->
      if (enabled) acquireProximityLock() else releaseProximityLock()
    }

    Function("getAudioRouteSync") {
      try {
        val am = audioManager
        var routeType = "receiver"
        var portName = ""
        if (am.isSpeakerphoneOn) {
          routeType = "speaker"
          portName = "Speakerphone"
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          val out = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { d ->
            d.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
              d.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
              d.type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET ||
              d.type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES
          }
          if (out != null) {
            routeType = when (out.type) {
              android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
              android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
              android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET,
              android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "headphones"
              else -> "other"
            }
            portName = out.productName?.toString() ?: ""
          }
        }
        mapOf(
          "type" to routeType,
          "name" to portName,
          "isBluetooth" to (routeType == "bluetooth"),
        )
      } catch (t: Throwable) {
        mapOf("type" to "unknown", "name" to "", "isBluetooth" to false)
      }
    }
  }

  private fun requestVoipFocus(am: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(attrs)
        .setAcceptsDelayedFocusGain(false)
        .setWillPauseWhenDucked(false)
        .build()
      focusRequest = req
      am.requestAudioFocus(req)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(
        null,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
      )
    }
  }

  private fun abandonVoipFocus(am: AudioManager) {
    val req = focusRequest
    if (req != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      am.abandonAudioFocusRequest(req)
      focusRequest = null
    } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      @Suppress("DEPRECATION")
      am.abandonAudioFocus(null)
    }
  }

  @Suppress("DEPRECATION")
  private fun acquireProximityLock() {
    try {
      if (proximityLock?.isHeld == true) return
      val pm = powerManager
      if (!pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
      val lock = pm.newWakeLock(
        PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,
        "Chatyy:ProximityCall"
      )
      lock.setReferenceCounted(false)
      lock.acquire(60 * 60 * 1000L) // 1h cap, released on deactivate
      proximityLock = lock
    } catch (t: Throwable) {
      android.util.Log.w("AudioSession", "acquireProximityLock failed: ${t.message}")
    }
  }

  private fun releaseProximityLock() {
    try {
      val lock = proximityLock
      if (lock != null && lock.isHeld) lock.release()
    } catch (t: Throwable) {
      android.util.Log.w("AudioSession", "releaseProximityLock failed: ${t.message}")
    } finally {
      proximityLock = null
    }
  }
}
