package com.onemundo.mail
import expo.modules.splashscreen.SplashScreenManager

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    // setTheme(R.style.AppTheme);
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)

    applyCallLockScreenFlags(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    applyCallLockScreenFlags(intent)
  }

  /**
   * [bug 2026-05-15 #981 android-lock-screen-must-unlock]
   * When the user accepts an incoming call from the lock-screen native UI,
   * MainActivity launches behind the keyguard — the user has to manually
   * unlock to reach the JS /call screen, so audio doesn't connect until
   * unlock ("atende mas tem que desbloquear pra completar a ligação").
   *
   * Pattern (WhatsApp/Telegram): the in-call activity itself is allowed to
   * show above the keyguard. We apply SHOW_WHEN_LOCKED + TURN_SCREEN_ON
   * AND request the (non-secure) keyguard be dismissed. On a secure device
   * the user can still see + interact with the call UI WITHOUT unlocking;
   * end-call works above the keyguard. Sensitive surfaces (chat, settings)
   * remain protected because IncomingCallListener.handleAndroidPendingCall
   * navigates straight to /call — the navigator stack underneath isn't
   * touched until the user unlocks and the keyguard naturally clears.
   */
  private fun applyCallLockScreenFlags(intent: Intent?) {
    val fromCall = intent?.getBooleanExtra("from_call_accept", false) == true
      || intent?.getStringExtra("accept_call_id") != null
      || intent?.action == "expo.modules.callkit.OPEN_CALL"
    if (!fromCall) return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        km?.requestDismissKeyguard(this, null)
      } else {
        @Suppress("DEPRECATION")
        window.addFlags(
          WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
        )
      }
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    } catch (_: Throwable) {}
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
