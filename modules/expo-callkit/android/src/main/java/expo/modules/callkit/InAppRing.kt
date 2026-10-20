package expo.modules.callkit

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * [2026-10-20 inapp-ring] Chamada recebida com o app ABERTO (Android) — nível
 * WhatsApp. Print do founder: com o app na frente aparecia o heads-up nativo
 * ("Aleff Duarte · Chamada de voz", Recusar/Atender) e, atrás, a
 * IncomingCallActivity (fundo #000; no print sai toda preta porque o app
 * inteiro tem FLAG_SECURE — screen_protect_all).
 *
 * Agora, com o app em 1º plano (MainActivity resumida, tela desbloqueada) E a
 * tela JS registrada (setInAppRingReady(true) — gate apiVersion + kill switch
 * `globalThis.__chatyy_android_inapp_ring` no JS):
 *   - NÃO abre a IncomingCallActivity;
 *   - a notificação do FGS (obrigatória) vai num canal BAIXO, sem heads-up,
 *     sem som e sem full-screen intent (só fica na gaveta, Atender/Recusar);
 *   - o JS recebe `onInAppIncomingCall` e mostra a tela de chamada do app;
 *   - toque + vibração continuam no CallRingingService (IncomingRinger).
 * Transições:
 *   - app vai pro 2º plano / tela bloqueia enquanto toca → [promote]: re-posta
 *     a notificação de chamada normal (heads-up + FSI, canal silencioso porque
 *     o IncomingRinger já toca);
 *   - app volta pra frente enquanto toca → [onAppForeground]: rebaixa a
 *     notificação, fecha a IncomingCallActivity e reemite o evento ao JS.
 * Fonte única da verdade: a tela JS existe enquanto o CallRingingService toca
 * aquele call_id. Atender/recusar em QUALQUER superfície para o serviço →
 * onDestroy → `onInAppRingEnded` → o JS some.
 */
object InAppRing {
    private const val TAG = "InAppRing"

    /** apiVersion exposto ao JS (ExpoCallKit.inAppRingApi()). */
    const val API = 1

    const val CHANNEL_ID = "incoming_calls_inapp"

    data class RingInfo(
        val callId: String,
        val callerName: String,
        val callerEmail: String,
        val conversationId: String,
        val hasVideo: Boolean,
        val callerAvatar: String,
        val isGroup: Boolean,
        val groupName: String,
        val muteRingtone: Boolean,
        val startedAt: Long,
    ) {
        fun toMap(): Map<String, Any?> = mapOf(
            "callId" to callId,
            "callerName" to callerName,
            "callerEmail" to callerEmail,
            "conversationId" to conversationId,
            "hasVideo" to hasVideo,
            "callerAvatar" to callerAvatar,
            "isGroup" to isGroup,
            "groupName" to groupName,
            "startedAt" to startedAt.toDouble(),
        )
    }

    /** Tela JS montada + flag ligada (setInAppRingReady). */
    @Volatile var jsReady: Boolean = false

    /** call_id → dados do toque (todo toque do CallRingingService). */
    private val ringing = ConcurrentHashMap<String, RingInfo>()

    /** call_ids hoje apresentados pela tela do app (notificação rebaixada). */
    private val inApp: MutableSet<String> = ConcurrentHashMap.newKeySet()

    fun isInApp(callId: String): Boolean = callId.isNotEmpty() && inApp.contains(callId)

    /**
     * O usuário está OLHANDO para o app: MainActivity resumida (flag do ciclo
     * de vida Expo — NÃO a importância do processo, que fica FOREGROUND com a
     * IncomingCallActivity/CallActivity na frente), tela ligada e sem
     * bloqueio, tela JS pronta.
     */
    fun canPresent(ctx: Context): Boolean {
        if (!jsReady) return false
        if (!ExpoCallKitModule.hasJsInstance()) return false
        if (!ExpoCallKitModule.isAppForeground) return false
        val app = ctx.applicationContext
        try {
            val km = app.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            if (km != null && km.isKeyguardLocked) return false
        } catch (_: Throwable) {}
        try {
            val pm = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm != null && !pm.isInteractive) return false
        } catch (_: Throwable) {}
        return true
    }

    fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            val ch = NotificationChannel(CHANNEL_ID, "Chamada recebida (app aberto)", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Chamada tocando enquanto o Chatyy está aberto na tela"
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            }
            nm.createNotificationChannel(ch)
        } catch (t: Throwable) {
            Log.w(TAG, "ensureChannel: ${t.message}")
        }
    }

    /**
     * CallRingingService.onStartCommand: registra o toque e decide a
     * superfície. Um 2º start do MESMO call_id mantém a decisão anterior.
     * true = tela do app (notificação baixa, sem FSI).
     */
    fun onRingStart(ctx: Context, info: RingInfo, alreadyRinging: Boolean): Boolean {
        if (info.callId.isEmpty()) return false
        val prev = ringing[info.callId]
        ringing[info.callId] = if (prev != null) info.copy(startedAt = prev.startedAt) else info
        if (alreadyRinging) return inApp.contains(info.callId)
        val use = try { canPresent(ctx) } catch (_: Throwable) { false }
        if (use) inApp.add(info.callId) else inApp.remove(info.callId)
        CallDiag.log("inapp_ring", info.callId, "use=${if (use) 1 else 0} js=${if (jsReady) 1 else 0} fg=${if (ExpoCallKitModule.isAppForeground) 1 else 0}", ctx.applicationContext)
        return use
    }

    /** Depois do startForeground: avisa o JS (também nos refresh de extras). */
    fun emitPresent(callId: String) {
        if (!inApp.contains(callId)) return
        val info = ringing[callId] ?: return
        ExpoCallKitModule.emitEvent("onInAppIncomingCall", info.toMap())
    }

    /** CallRingingService.onDestroy (atendeu, recusou, cancelou, perdeu). */
    fun onRingStop(callId: String?) {
        if (callId.isNullOrEmpty()) return
        ringing.remove(callId)
        inApp.remove(callId)
        ExpoCallKitModule.emitEvent("onInAppRingEnded", mapOf("callId" to callId))
    }

    /** Toque que o JS deve mostrar agora (rebaixa a notificação se preciso). */
    fun current(ctx: Context): Map<String, Any?>? {
        if (!canPresent(ctx)) return null
        val live = ringing.values
            .filter { CallRingingService.ringingCallIds.contains(it.callId) && !isAcceptedOrEnded(ctx, it.callId) }
            .maxByOrNull { it.startedAt } ?: return null
        if (!inApp.contains(live.callId)) demote(ctx, live)
        return live.toMap()
    }

    /** MainActivity resumiu: toques nativos em andamento passam para a tela do app. */
    fun onAppForeground(ctx: Context) {
        if (ringing.isEmpty()) return
        if (!canPresent(ctx)) return
        for (info in ringing.values.toList()) {
            if (!CallRingingService.ringingCallIds.contains(info.callId)) continue
            if (isAcceptedOrEnded(ctx, info.callId)) continue
            if (!inApp.contains(info.callId)) demote(ctx, info)
            ExpoCallKitModule.emitEvent("onInAppIncomingCall", info.toMap())
        }
    }

    /** MainActivity pausou (home, outro app, tela bloqueou): volta o nativo. */
    fun onAppBackground(ctx: Context) {
        if (inApp.isEmpty()) return
        for (id in inApp.toList()) promote(ctx, id)
    }

    /** Atender pela tela do app: sai do conjunto in-app (sem promote na pausa). */
    fun onAcceptFromApp(callId: String) {
        inApp.remove(callId)
    }

    /** JS desmontou / kill switch: tudo que estava na tela do app volta pro nativo. */
    fun onJsDetached(ctx: Context) {
        jsReady = false
        for (id in inApp.toList()) promote(ctx, id)
    }

    private fun isAcceptedOrEnded(ctx: Context, callId: String): Boolean {
        return try {
            IncomingCallRegistry.isAcceptedHere(ctx, callId) || IncomingCallRegistry.isEnded(ctx, callId)
        } catch (_: Throwable) { false }
    }

    private fun demote(ctx: Context, info: RingInfo) {
        val app = ctx.applicationContext
        inApp.add(info.callId)
        try {
            ensureChannel(app)
            val n = CallNotificationService.buildIncomingCallNotification(
                app, info.callId, info.callerName, info.callerEmail, info.conversationId,
                info.hasVideo, info.callerAvatar,
                muteRingtone = info.muteRingtone, isGroup = info.isGroup, groupName = info.groupName,
                inApp = true
            )
            val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Mesmo (tag=null, id) do startForeground → troca no lugar.
            nm.notify(info.callId.hashCode(), n)
            // Notificação do caminho de fallback (tag) — some também.
            try { nm.cancel("call_notification", info.callId.hashCode()) } catch (_: Throwable) {}
        } catch (t: Throwable) {
            Log.w(TAG, "demote ${info.callId}: ${t.message}")
        }
        // Fecha a tela nativa de toque (só ela: target=ringer).
        try {
            app.sendBroadcast(Intent("expo.modules.callkit.CLOSE_CALL_ACTIVITY").apply {
                setPackage(app.packageName)
                putExtra("call_id", info.callId)
                putExtra("target", "ringer")
            })
        } catch (_: Throwable) {}
        CallDiag.log("inapp_demote", info.callId, "", app)
    }

    private fun promote(ctx: Context, callId: String) {
        val app = ctx.applicationContext
        if (!inApp.remove(callId)) return
        val info = ringing[callId] ?: return
        if (!CallRingingService.ringingCallIds.contains(callId)) return
        if (isAcceptedOrEnded(app, callId)) return
        try {
            CallNotificationService.createNotificationChannel(app)
            // Canal ALTO silencioso: heads-up + FSI; o som já vem do IncomingRinger.
            val n = CallNotificationService.buildIncomingCallNotification(
                app, callId, info.callerName, info.callerEmail, info.conversationId,
                info.hasVideo, info.callerAvatar,
                muteRingtone = true, isGroup = info.isGroup, groupName = info.groupName,
                realert = true
            )
            val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(callId.hashCode(), n)
        } catch (t: Throwable) {
            Log.w(TAG, "promote $callId: ${t.message}")
        }
        CallDiag.log("inapp_promote", callId, "", app)
    }
}
