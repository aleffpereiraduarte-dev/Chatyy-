// [2026-10-23 push-rapido item 4] Marcadores de tempo do push no Android (antes/depois do adiamento
// do RN — ChatyyRnGate). Só tempos e códigos, NUNCA conteúdo/ids.
//
// Logcat (tag ChatyyPushT), uma linha por push:
//   push_t kind=chat cold=1 rn=deferred rn_ms=-1 pre_app_ms=180 proc_to_recv=420 journal=+2 ack=+3 notif=+95 imp=300
//     cold      = 1º push deste processo (o processo nasceu para ele, se proc_to_recv for pequeno)
//     rn        = deferred (adiado) | eager (carregado no onCreate) | loaded (já estava)
//     rn_ms     = custo do loadReactNative medido neste processo (-1 = não rodou antes do push)
//     pre_app_ms= início do processo → Application.onCreate do app (bind + providers)
//     proc_to_recv = início do processo → onMessageReceived
//     journal/ack/notif = ms desde onMessageReceived até journal gravado / ack disparado / notificação postada
//   adb logcat -s ChatyyPushT ChatyyRnGate ChatDeliveryReporter
//
// Telemetria (canal existente das métricas do push E2EE: ExpoCallKit.e2ee5PushMetricsTake → JS
// services/e2ee/pushMetrics.js → e2ee5.php e2ee5_metrics como nse_pt_*; tabela e2ee5_metrics):
//   pt_cold_def / pt_cold_eager / pt_warm                 → quantos pushes em cada modo
//   pt_cold_def_le300|le700|le1500|gt1500                 → início do processo → notificação (cold, adiado)
//   pt_cold_eager_le300|…                                 → idem com o RN carregado no onCreate (antes)
//   pt_warm_le100|le300|le1000|gt1000                     → onMessageReceived → notificação (processo vivo)
//   pt_rn_eager_le80|le200|le500|gt500 / pt_rn_lazy_…     → custo do loadReactNative
// Contadores em SharedPreferences "chatyy_push_fast" chave "pt_counts" (máx. 24 chaves), lidos e
// zerados junto com os do E2EE (ChatPushE2EE.takeMetrics).
// Kill: SharedPreferences "chatyy_push_fast" timing=false → sem contadores (logcat continua).
package expo.modules.callkit

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject

object ChatyyPushTiming {
    private const val TAG = "ChatyyPushT"
    private const val KEY = "pt_counts"
    private const val MAX_KEYS = 24

    @Volatile private var firstPushSeen = false

    class Mark internal constructor(
        val cold: Boolean,
        val t0: Long,
        val procToRecv: Long,
        val rnAtRecv: String,
    ) {
        @Volatile var journalMs: Long = -1
        @Volatile var ackMs: Long = -1
        @Volatile var notifMs: Long = -1
        /** "chat" = notificação postada pelo MessagingStyle (só esse conta nos contadores). */
        @Volatile var kind: String = "other"
        fun since(): Long = SystemClock.elapsedRealtime() - t0
    }

    private fun procAge(): Long = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
            SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime() else -1L
    } catch (_: Throwable) { -1L }

    /** Início do onMessageReceived. Nunca lança. */
    fun begin(): Mark {
        val cold = !firstPushSeen
        firstPushSeen = true
        val rn = when {
            ChatyyRnGate.deferred && !ChatyyRnGate.isLoaded() -> "deferred"
            ChatyyRnGate.deferred -> "loaded"
            ChatyyRnGate.isLoaded() -> "eager"
            else -> "unknown"
        }
        return Mark(cold, SystemClock.elapsedRealtime(), procAge(), rn)
    }

    /** Fim do tratamento do push (kind = chat | expo:<tipo> | t:<tipo> | other). */
    fun finish(ctx: Context, m: Mark, kind: String) {
        try {
            Log.i(TAG, "push_t kind=$kind cold=${if (m.cold) 1 else 0} rn=${m.rnAtRecv} rn_ms=${ChatyyRnGate.rnLoadMs}" +
                " pre_app_ms=${ChatyyRnGate.preAppMs} proc_to_recv=${m.procToRecv} journal=+${m.journalMs}" +
                " ack=+${m.ackMs} notif=+${m.notifMs} total=+${m.since()} imp=${ChatyyRnGate.startImportance}")
            if (kind != "chat" || m.notifMs < 0) return
            val codes = ArrayList<String>(2)
            // "a frio" de verdade = o processo nasceu para este push (< 10 s de idade no recv)
            if (m.cold && m.procToRecv in 0L..10_000L) {
                val base = if (m.rnAtRecv == "deferred") "pt_cold_def" else "pt_cold_eager"
                codes.add(base)
                codes.add(base + bucket(m.procToRecv + m.notifMs, longArrayOf(300, 700, 1500)))
            } else {
                codes.add("pt_warm")
                codes.add("pt_warm" + bucket(m.notifMs, longArrayOf(100, 300, 1000)))
            }
            count(ctx, codes)
        } catch (_: Throwable) {}
    }

    /** Custo do loadReactNative (ChatyyRnGate). Grava fora da main (não pesa no cold start). */
    fun noteRnLoad(ctx: Context, deferred: Boolean, reason: String, ms: Long) {
        val app = ctx.applicationContext
        try {
            Thread({
                val base = if (deferred) "pt_rn_lazy" else "pt_rn_eager"
                count(app, listOf(base + bucket(ms, longArrayOf(80, 200, 500))))
            }, "chatyy-pt").apply { isDaemon = true }.start()
        } catch (_: Throwable) {}
    }

    private fun bucket(v: Long, edges: LongArray): String {
        for (e in edges) if (v <= e) return "_le$e"
        return "_gt" + edges.last()
    }

    private fun enabled(ctx: Context): Boolean = try {
        ctx.getSharedPreferences(ChatyyRnGate.PREFS, Context.MODE_PRIVATE).getBoolean("timing", true)
    } catch (_: Throwable) { true }

    @Synchronized
    private fun count(ctx: Context, codes: List<String>) {
        try {
            if (!enabled(ctx)) return
            val sp = ctx.getSharedPreferences(ChatyyRnGate.PREFS, Context.MODE_PRIVATE)
            val o = try { JSONObject(sp.getString(KEY, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
            for (c in codes) {
                val k = c.take(40)
                if (o.has(k) || o.length() < MAX_KEYS) o.put(k, o.optInt(k, 0) + 1)
            }
            sp.edit().putString(KEY, o.toString()).apply()
        } catch (_: Throwable) {}
    }

    /** Lê e ZERA (chamado por ChatPushE2EE.takeMetrics, que junta com os contadores do E2EE). */
    @Synchronized
    fun take(ctx: Context): JSONObject {
        return try {
            val sp = ctx.getSharedPreferences(ChatyyRnGate.PREFS, Context.MODE_PRIVATE)
            val o = try { JSONObject(sp.getString(KEY, "{}") ?: "{}") } catch (_: Throwable) { JSONObject() }
            if (o.length() > 0) sp.edit().remove(KEY).apply()
            o
        } catch (_: Throwable) { JSONObject() }
    }
}
