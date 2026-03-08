package expo.modules.callkit

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoCallKitModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoCallKit")

    Events("onCallAnswered", "onCallEnded", "onVoipTokenReceived", "onIncomingCall")

    AsyncFunction("setup") {
      // No-op on Android - uses regular FCM notifications
    }

    AsyncFunction("displayIncomingCall") { callId: String, callerName: String, hasVideo: Boolean ->
      // No-op on Android
    }

    Function("endCall") { callId: String ->
      // No-op on Android
    }

    Function("registerVoipPush") {
      // No-op on Android - uses FCM
    }
  }
}
