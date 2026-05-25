package expo.modules.callkit

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.util.Log

/**
 * [Goal 1 ring-fix 2026-05-25] Dedicated, authoritative looping ringtone
 * player for incoming calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the "ring" depended SOLELY on the NotificationChannel sound
 * (CallNotificationService.CHANNEL_ID setSound). On targetSdk 35 / Android
 * 14-15 that sound goes silent in three independent failure modes that all
 * surfaced as user reports of "Android não toca":
 *   1. USE_FULL_SCREEN_INTENT runtime-denied → the heads-up may post quietly.
 *   2. ForegroundServiceStartNotAllowedException → the FGS (and thus its
 *      channel-attached notification) never posts at all.
 *   3. The STAGE-B Telecom self-managed Connection (addNewIncomingCall →
 *      ChatyyConnectionService.setRinging) can change the system audio mode
 *      / claim focus and duck or suppress the channel ringtone.
 *
 * This object owns a MediaPlayer that loops the default ringtone on the
 * STREAM_RING / USAGE_NOTIFICATION_RINGTONE pipeline. Sound therefore NEVER
 * depends on a notification posting or on Telecom's behaviour — our player is
 * authoritative. Both the FGS (CallRingingService) and the FCM background
 * fallback (CallFirebaseMessagingService catch block) call into here so the
 * ring is guaranteed in both branches.
 *
 * Ringer-mode aware:
 *   - RINGER_MODE_SILENT  → no sound (vibration handled separately by the FGS).
 *   - RINGER_MODE_VIBRATE → no sound (vibration only — owned by the FGS).
 *   - RINGER_MODE_NORMAL  → loop the ringtone.
 *
 * Thread-safety: start()/stop() are synchronized; idempotent. A new start()
 * while already playing is a no-op (we keep the single existing loop) so two
 * back-to-back call invites don't stack two ringers.
 *
 * Everything is guarded so a media failure never crashes the caller.
 */
object IncomingRinger {

  private const val TAG = "IncomingRinger"

  private val lock = Any()
  private var player: MediaPlayer? = null

  /**
   * Start the looping ringtone if the ringer mode permits sound. Idempotent —
   * if a ringtone is already playing this is a no-op. Never throws.
   *
   * @param muteRingtone when true (push payload mute_ringtone=1, "modo
   *        silencioso para ligações") we skip sound entirely regardless of the
   *        system ringer mode. Vibration is owned elsewhere.
   */
  fun start(context: Context, muteRingtone: Boolean = false) {
    synchronized(lock) {
      try {
        if (player != null) {
          Log.d(TAG, "start: ringtone already playing — no-op")
          return
        }
        if (muteRingtone) {
          Log.d(TAG, "start: muteRingtone=true — not playing sound")
          return
        }

        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val mode = am?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
        if (mode == AudioManager.RINGER_MODE_SILENT) {
          Log.d(TAG, "start: ringer mode SILENT — not playing")
          return
        }
        if (mode == AudioManager.RINGER_MODE_VIBRATE) {
          // Vibration is owned by CallRingingService — do not play sound.
          Log.d(TAG, "start: ringer mode VIBRATE — vibration only, no sound")
          return
        }

        // Resolve the user's default ringtone. getActualDefaultRingtoneUri
        // resolves the *current* default (vs getDefaultUri which may return a
        // settings placeholder URI that some OEMs fail to play).
        val uri: Uri? =
          RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        if (uri == null) {
          Log.w(TAG, "start: no default ringtone URI available — cannot play")
          return
        }

        val attrs = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .setLegacyStreamType(AudioManager.STREAM_RING)
          .build()

        val mp = MediaPlayer().apply {
          setAudioAttributes(attrs)
          isLooping = true
          setDataSource(context, uri)
          setOnErrorListener { _, what, extra ->
            Log.w(TAG, "MediaPlayer error what=$what extra=$extra")
            // Returning true marks the error handled; we stop on our side.
            try { stop() } catch (_: Throwable) {}
            true
          }
          prepare() // synchronous; ringtone URIs are local content URIs
          start()
        }
        player = mp
        Log.d(TAG, "start: ringtone looping (mode=$mode uri=$uri)")
      } catch (t: Throwable) {
        Log.w(TAG, "start failed: ${t.message}")
        // Best-effort cleanup of a half-initialized player.
        try {
          player?.release()
        } catch (_: Throwable) {}
        player = null
      }
    }
  }

  /**
   * Stop + release the looping ringtone. Idempotent. Never throws. Called from
   * CallRingingService.onDestroy / the answer / decline / stop action paths and
   * from any place that tears down the ringing UI.
   */
  fun stop() {
    synchronized(lock) {
      val mp = player ?: return
      player = null
      try {
        if (mp.isPlaying) mp.stop()
      } catch (t: Throwable) {
        Log.w(TAG, "stop: mp.stop() failed: ${t.message}")
      }
      try {
        mp.release()
      } catch (t: Throwable) {
        Log.w(TAG, "stop: mp.release() failed: ${t.message}")
      }
      Log.d(TAG, "stop: ringtone released")
    }
  }

  /** Whether a ringtone is currently looping (diagnostics / tests). */
  fun isPlaying(): Boolean = synchronized(lock) { player != null }
}
