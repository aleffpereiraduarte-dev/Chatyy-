// [2026-10-23 push-rapido item 4] Processo que NASCE por um push (FCM com o app morto) não espera
// o React Native subir para mostrar a notificação / gravar o journal / mandar o ✓✓.
//
// Antes: MainApplication.onCreate rodava loadReactNative (SoLoader.init + libs da nova arquitetura:
// libreactnative/hermes/appmodules) + ApplicationLifecycleDispatcher (instancia TODOS os pacotes Expo:
// LiveKit/WebRTC ADM, hub de privacidade…) NA MAIN THREAD, e o Android só cria o
// CallFirebaseMessagingService depois do Application.onCreate → todo push "a frio" pagava isso.
//
// Agora (MainApplication gerado por plugins/with-android-rn-gate.js chama install()):
//   - Processo aberto para uma Activity (importance FOREGROUND no onCreate), Android < 10 ou
//     kill switch → exatamente como antes (carrega na hora; só mede o custo).
//   - Senão (push/receiver/job) → NÃO carrega no onCreate. Carrega:
//       a) sob demanda, ANTES de qualquer uso do RN: MainActivity.createReactActivityDelegate
//          (construtor da Activity), MainApplication.reactHost (lazy — HeadlessJS/expo-task-manager/
//          qualquer um), onActivityPreCreated de Activities que não são nossas nativas, e o delegate
//          do expo-notifications no CallFirebaseMessagingService;
//       b) em 2º plano (thread de prioridade baixa) logo DEPOIS que o push terminou (pushDone) ou
//          PRELOAD_FALLBACK_MS após o onCreate → abrir pela notificação continua rápido.
//   - Activities nativas do expo-callkit (tela de chamada, bolha) não precisam do RN: rodam só o
//     ApplicationLifecycleDispatcher (barato, instala o hub de captura) e disparam o preload.
//
// Kill switches (SharedPreferences "chatyy_push_fast", padrão LIGADO; JS: ExpoCallKit.setPushFastFlags):
//   rn_defer=false   → volta ao carregamento no onCreate (próximo processo).
//   rn_preload=false → não pré-carrega em 2º plano (só sob demanda).
// Logcat: tag ChatyyRnGate (rn_load ms, quem pediu). Contadores: ChatyyPushTiming (pt_rn_*).
package expo.modules.callkit

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

object ChatyyRnGate {
    private const val TAG = "ChatyyRnGate"
    const val PREFS = "chatyy_push_fast"
    private const val PRELOAD_AFTER_PUSH_MS = 250L
    private const val PRELOAD_FALLBACK_MS = 3_000L
    private const val OFF_MAIN_LIFECYCLE_WAIT_MS = 500L

    @Volatile private var app: Application? = null
    @Volatile private var rnLoader: Runnable? = null
    @Volatile private var lifecycleCreate: Runnable? = null
    private val rnLock = Any()
    @Volatile private var rnDone = false
    private val lifecycleDone = AtomicBoolean(false)
    private val preloadScheduled = AtomicBoolean(false)
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    /** true = este processo adiou o RN (nasceu em 2º plano). */
    @Volatile var deferred: Boolean = false
        private set
    /** importance do processo no Application.onCreate (diagnóstico). */
    @Volatile var startImportance: Int = -1
        private set
    /** ms do início do processo até o install() (bind + providers + super.onCreate). -1 = desconhecido. */
    @Volatile var preAppMs: Long = -1
        private set
    /** custo medido do loadReactNative / ApplicationLifecycleDispatcher (ms; -1 = ainda não rodou). */
    @Volatile var rnLoadMs: Long = -1
        private set
    @Volatile var lifecycleMs: Long = -1
        private set
    @Volatile var rnLoadedBy: String = ""
        private set

    fun isLoaded(): Boolean = rnDone

    private fun flag(ctx: Context, key: String): Boolean = try {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(key, true)
    } catch (_: Throwable) { true }

    /**
     * Chamado pelo MainApplication.onCreate NO LUGAR de `loadReactNative(this)` +
     * `ApplicationLifecycleDispatcher.onApplicationCreate(this)`. Nunca deixa o app sem RN:
     * qualquer falha aqui → carrega na hora (comportamento antigo).
     */
    @JvmStatic
    fun install(application: Application, loadRn: Runnable, lifecycle: Runnable) {
        app = application
        rnLoader = loadRn
        lifecycleCreate = lifecycle
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                preAppMs = SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime()
            }
        } catch (_: Throwable) {}
        var defer = false
        try {
            val info = ActivityManager.RunningAppProcessInfo()
            ActivityManager.getMyMemoryState(info)
            startImportance = info.importance
            defer = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
                info.importance != ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND &&
                flag(application, "rn_defer")
            if (defer) application.registerActivityLifecycleCallbacks(activityHook)
        } catch (t: Throwable) {
            Log.w(TAG, "install: sem adiar (${t.javaClass.simpleName})")
            defer = false
        }
        deferred = defer
        if (!defer) {
            ensure("eager")
            return
        }
        Log.i(TAG, "rn_defer ON importance=$startImportance pre_app_ms=$preAppMs")
        // Teto: mesmo sem push/Activity, o RN fica pronto em poucos segundos (janela curta).
        schedulePreload(PRELOAD_FALLBACK_MS, "fallback")
    }

    /** O push foi tratado (notificação/journal/ack) → pré-carrega em 2º plano. Barato se já carregou. */
    @JvmStatic
    fun pushDone() {
        if (!deferred || rnDone) return
        schedulePreload(PRELOAD_AFTER_PUSH_MS, "after_push")
    }

    private fun schedulePreload(delayMs: Long, why: String) {
        val a = app ?: return
        if (rnDone || !flag(a, "rn_preload")) return
        if (!preloadScheduled.compareAndSet(false, true)) {
            // já agendado; um pedido "after_push" adianta o fallback
            if (why != "after_push") return
        }
        mainHandler.postDelayed({ startPreloadThread(why) }, delayMs)
    }

    private val preloadStarted = AtomicBoolean(false)

    private fun startPreloadThread(why: String) {
        if (rnDone || !preloadStarted.compareAndSet(false, true)) return
        try {
            Thread({
                try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND) } catch (_: Throwable) {}
                try {
                    loadRnOnce("preload_$why")
                } catch (t: Throwable) {
                    // Não derruba o processo daqui: o próximo ensure() na main tenta de novo (e falha
                    // igual ao comportamento antigo, se for o caso).
                    Log.w(TAG, "preload falhou: ${t.javaClass.simpleName}: ${t.message}")
                }
                if (rnDone) mainHandler.post { runLifecycleOnce() }
            }, "chatyy-rn-preload").apply { isDaemon = true }.start()
        } catch (t: Throwable) {
            preloadStarted.set(false)
        }
    }

    /**
     * Garante RN carregado + ApplicationLifecycleDispatcher rodado. Idempotente, thread-safe.
     * Na main: síncrono. Fora da main: carrega aqui e pede o dispatcher à main (espera curta).
     */
    @JvmStatic
    fun ensure(reason: String) {
        if (rnDone && lifecycleDone.get()) return
        loadRnOnce(reason)
        ensureLifecycle()
    }

    /** Só o ApplicationLifecycleDispatcher (Activities nativas que não usam RN). */
    @JvmStatic
    fun ensureLifecycle() {
        if (lifecycleDone.get()) return
        if (Looper.myLooper() == Looper.getMainLooper()) {
            runLifecycleOnce()
        } else {
            val latch = CountDownLatch(1)
            mainHandler.post { try { runLifecycleOnce() } finally { latch.countDown() } }
            try { latch.await(OFF_MAIN_LIFECYCLE_WAIT_MS, TimeUnit.MILLISECONDS) } catch (_: Throwable) {}
        }
    }

    private fun loadRnOnce(reason: String) {
        if (rnDone) return
        val ms: Long = synchronized(rnLock) {
            if (rnDone) return
            val t0 = SystemClock.elapsedRealtime()
            rnLoader?.run() // exceção sobe (igual ao loadReactNative no onCreate de antes)
            val d = SystemClock.elapsedRealtime() - t0
            rnLoadMs = d
            rnLoadedBy = reason
            rnDone = true
            d
        }
        Log.i(TAG, "rn_load ms=$ms by=$reason deferred=$deferred importance=$startImportance")
        val a = app
        if (a != null) try { ChatyyPushTiming.noteRnLoad(a, deferred, reason, ms) } catch (_: Throwable) {}
    }

    private fun runLifecycleOnce() {
        if (!lifecycleDone.compareAndSet(false, true)) return
        val t0 = SystemClock.elapsedRealtime()
        lifecycleCreate?.run()
        lifecycleMs = SystemClock.elapsedRealtime() - t0
        Log.i(TAG, "app_lifecycle ms=$lifecycleMs deferred=$deferred")
    }

    private val activityHook = object : Application.ActivityLifecycleCallbacks {
        private fun hook(activity: Activity) {
            val native = activity.javaClass.name.startsWith("expo.modules.callkit.")
            if (native) {
                ensureLifecycle()
                startPreloadThread("native_activity")
            } else {
                ensure("activity:" + activity.javaClass.simpleName)
            }
        }
        // API 29+ (install só adia com SDK >= Q): antes do onCreate da Activity.
        override fun onActivityPreCreated(activity: Activity, savedInstanceState: Bundle?) { hook(activity) }
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) { hook(activity) }
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }
}
