package expo.modules.chatyyprivacy

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

// [2026-10-15 screen-protect-all] Instala o hub no Application.onCreate
// (ApplicationLifecycleDispatcher, já chamado pelo MainApplication do Expo):
// os ActivityLifecycleCallbacks pegam a MainActivity no onCreate → FLAG_SECURE
// antes do 1º frame e prévia preta em Recentes, sem plugin no MainActivity.
class ExpoChatPrivacyPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> {
    return listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        ScreenProtectHub.install(application)
      }
    })
  }
}
