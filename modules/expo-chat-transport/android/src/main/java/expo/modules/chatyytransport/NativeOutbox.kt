package expo.modules.chatyytransport

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import expo.modules.chatyychatstore.ChatyyStoreDB
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * [2026-10-15 fase 4] Cola Android da fila de envio nativa: OutboxCore +
 * persistência no expo-chat-store + credenciais (arquivo privado fora do backup)
 * + WorkManager (reenvia com o app FECHADO / processo morto, com rede).
 *
 * O motor roda NO MESMO executor do transporte (ChatTransport.exec): ver se o
 * socket está autenticado e mandar o frame `chat_send` é seguro sem locks.
 */
internal object NativeOutbox {
  private const val TAG = "ChatyyOutbox"
  const val WORK_NAME = "chatyy-native-outbox"

  @Volatile private var core: OutboxCore? = null
  @Volatile private var appCtx: Context? = null

  fun get(ctx: Context): OutboxCore {
    core?.let { return it }
    synchronized(this) {
      core?.let { return it }
      val app = ctx.applicationContext ?: ctx
      appCtx = app
      val store = ChatyyStoreDB.get(app)
      val c = OutboxCore(StoreAdapter(store), NetAdapter, ChatTransport.executor())
      c.credsLoader = { a -> Creds.load(app, a) }
      // [e2ee5 WP-08b] conversa E2EE: cifra antes de gravar (gate dentro; desligado = hoje)
      c.sealer = E2eeOutboxSealer(app) { a -> Creds.load(app, a) }
      c.accountsLoader = { Creds.accounts(app) }
      core = c
      return c
    }
  }

  fun peek(): OutboxCore? = core

  /** Agenda o dreno em 2º plano (rede obrigatória; KEEP = não duplica). */
  fun scheduleWork(ctx: Context, delayMs: Long = 0L) {
    try {
      val req = OneTimeWorkRequest.Builder(ChatyyOutboxWorker::class.java)
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .apply { if (delayMs > 0) setInitialDelay(delayMs, TimeUnit.MILLISECONDS) }
        .build()
      WorkManager.getInstance(ctx.applicationContext ?: ctx).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, req)
    } catch (t: Throwable) {
      Log.w(TAG, "scheduleWork failed", t)
    }
  }

  fun forgetAll(ctx: Context) {
    Creds.clear(ctx)
    try { WorkManager.getInstance(ctx.applicationContext ?: ctx).cancelUniqueWork(WORK_NAME) } catch (_: Throwable) {}
  }

  /** App indo pro fundo / processo vivo sem tela: se há fila, garante o Worker. */
  fun onBackground() {
    val c = core ?: return
    val ctx = appCtx ?: return
    ChatTransport.post {
      if (c.pendingCount() > 0) scheduleWork(ctx)
    }
  }

  private class StoreAdapter(val s: ChatyyStoreDB) : OutboxCore.Storage {
    override fun put(account: String, item: JSONObject): String = s.outboxPut(account, item)
    override fun all(account: String): JSONArray = try { JSONArray(s.outboxAll(account)) } catch (_: Throwable) { JSONArray() }
    override fun patch(account: String, cmi: String, p: JSONObject) = s.outboxPatch(account, cmi, p)
    override fun remove(account: String, cmi: String) = s.outboxRemove(account, cmi)
    override fun recover(account: String): Int = s.outboxRecover(account)
    override fun sent(account: String, cmi: String, conv: String, server: JSONObject) = s.outboxSent(account, cmi, conv, server)
    override fun failed(account: String, cmi: String, conv: String) = s.outboxFailedMark(account, cmi, conv)
  }

  private object NetAdapter : OutboxCore.Net {
    override fun online(): Boolean = ChatTransport.netUp
    override fun wsReady(account: String): Boolean = ChatTransport.nativeSendReady(account)
    override fun wsSend(account: String, text: String): Boolean = ChatTransport.nativeSendRaw(account, text)
    override fun wsE2ee(account: String): Boolean = ChatTransport.nativeSendE2ee(account)
  }

  /**
   * Bearer + base por conta, p/ reenviar sem o JS. Arquivo em
   * noBackupFilesDir (privado do app, fora do Auto Backup). Logout apaga.
   */
  object Creds {
    private fun file(ctx: Context): File = File(File(ctx.noBackupFilesDir, "chatyy-outbox").apply { mkdirs() }, "creds.json")

    @Synchronized fun save(ctx: Context, account: String, token: String, base: String) {
      try {
        val f = file(ctx)
        val o = try { JSONObject(f.readText()) } catch (_: Throwable) { JSONObject() }
        o.put(account.trim().lowercase(), JSONObject().put("t", token).put("b", base))
        val tmp = File(f.path + ".tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(f)
      } catch (t: Throwable) { Log.w(TAG, "creds save failed", t) }
    }

    @Synchronized fun load(ctx: Context, account: String): OutboxCore.Creds? = try {
      val o = JSONObject(file(ctx).readText()).optJSONObject(account.trim().lowercase())
      if (o == null || o.optString("t").isEmpty()) null else OutboxCore.Creds(account.trim().lowercase(), o.optString("t"), o.optString("b").ifEmpty { "https://chatyy.com.br" })
    } catch (_: Throwable) { null }

    @Synchronized fun accounts(ctx: Context): List<String> = try {
      val o = JSONObject(file(ctx).readText()); val l = ArrayList<String>(); val it = o.keys(); while (it.hasNext()) l.add(it.next()); l
    } catch (_: Throwable) { emptyList() }

    @Synchronized fun remove(ctx: Context, account: String) {
      try {
        val f = file(ctx); val o = JSONObject(f.readText()); o.remove(account.trim().lowercase()); f.writeText(o.toString())
      } catch (_: Throwable) {}
    }

    @Synchronized fun clear(ctx: Context) { try { file(ctx).delete() } catch (_: Throwable) {} }
  }
}

/**
 * WorkManager: drena a fila nativa com o app fechado (processo pode ter sido
 * morto). Só roda com rede (constraint). Pendências → retry com backoff.
 */
class ChatyyOutboxWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
  override fun doWork(): Result {
    return try {
      ChatTransport.init(applicationContext)
      val core = NativeOutbox.get(applicationContext)
      val pending = core.drainBlocking(8 * 60 * 1000L)
      if (pending && runAttemptCount < 20) Result.retry() else Result.success()
    } catch (t: Throwable) {
      Log.w("ChatyyOutbox", "worker failed", t)
      Result.retry()
    }
  }
}
