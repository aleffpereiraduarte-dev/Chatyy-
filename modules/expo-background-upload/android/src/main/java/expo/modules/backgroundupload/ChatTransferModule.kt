package expo.modules.backgroundupload

import android.content.Context
import androidx.work.ExistingWorkPolicy
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * [2026-10-09 media-native] JS bridge for background chat media transfers
 * (ChatTransferWorker). JS: services/bgTransfer.js — loaded with
 * requireOptionalNativeModule('ChatyyTransfer'), so binaries without this
 * module keep the foreground path.
 */
class ChatTransferModule : Module() {
  private val ctx: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("no_context")

  private fun num(v: Any?): Double? = (v as? Number)?.toDouble()

  override fun definition() = ModuleDefinition {
    Name("ChatyyTransfer")

    Events("onTransferProgress", "onTransferDone")

    OnCreate {
      ChatTransferEvents.listener = { name, body ->
        try {
          sendEvent(name, body)
        } catch (_: Throwable) {
        }
      }
    }

    OnDestroy {
      ChatTransferEvents.listener = null
    }

    Function("isAvailable") {
      true
    }

    // { id, fileUri, base, bearer, uploadId, chunkSize, totalSize,
    //   skipChunks?, filename?, contentType?, userEmail?, context?, title? }
    AsyncFunction("enqueueUpload") { spec: Map<String, Any> ->
      val id = spec["id"] as? String ?: return@AsyncFunction false
      val fileUri = spec["fileUri"] as? String ?: return@AsyncFunction false
      val base = (spec["base"] as? String)?.trimEnd('/') ?: return@AsyncFunction false
      val uploadId = spec["uploadId"] as? String ?: return@AsyncFunction false
      val chunkSize = num(spec["chunkSize"])?.toLong() ?: return@AsyncFunction false
      val totalSize = num(spec["totalSize"])?.toLong() ?: return@AsyncFunction false
      if (id.isEmpty() || uploadId.isEmpty() || !base.startsWith("https://") || chunkSize <= 0 || totalSize <= 0) {
        return@AsyncFunction false
      }
      val c = ctx
      val existing = ChatTransferStore.get(c, id)
      val est = existing?.optString("state")
      if (existing != null && (est == "running" || est == "queued")) {
        val b = spec["bearer"] as? String
        if (!b.isNullOrEmpty()) ChatTransferStore.update(c, id) { it.put("bearer", b) }
        ChatTransferWorker.enqueue(c, id, ExistingWorkPolicy.KEEP)
        return@AsyncFunction true
      }
      val totalChunks = ((totalSize + chunkSize - 1) / chunkSize).toInt()
      val skip = HashSet<Int>()
      (spec["skipChunks"] as? List<*>)?.forEach { v -> num(v)?.toInt()?.let { skip.add(it) } }
      val pending = JSONArray()
      for (i in 0 until totalChunks) if (!skip.contains(i)) pending.put(i)
      val rec = JSONObject()
        .put("id", id)
        .put("kind", "upload")
        .put("state", "running")
        .put("progress", if (totalChunks > 0) (totalChunks - pending.length()).toDouble() / totalChunks else 0.0)
        .put("fileUri", fileUri)
        .put("base", base)
        .put("bearer", spec["bearer"] as? String ?: "")
        .put("uploadId", uploadId)
        .put("chunkSize", chunkSize)
        .put("totalSize", totalSize)
        .put("totalChunks", totalChunks)
        .put("pending", pending)
        .put("filename", spec["filename"] as? String ?: "upload")
        .put("contentType", spec["contentType"] as? String ?: "application/octet-stream")
        .put("userEmail", spec["userEmail"] as? String ?: "")
        .put("context", spec["context"] as? String ?: "chat")
        .put("title", spec["title"] as? String ?: "")
        .put("completing", pending.length() == 0)
        .put("createdAt", System.currentTimeMillis().toDouble() / 1000.0)
      ChatTransferStore.put(c, rec)
      ChatTransferWorker.enqueue(c, id, ExistingWorkPolicy.REPLACE)
      true
    }

    // { id, url, dest, headers?, title? }
    AsyncFunction("enqueueDownload") { spec: Map<String, Any> ->
      val id = spec["id"] as? String ?: return@AsyncFunction false
      val url = spec["url"] as? String ?: return@AsyncFunction false
      val dest = spec["dest"] as? String ?: return@AsyncFunction false
      if (id.isEmpty() || dest.isEmpty() || !(url.startsWith("https://") || url.startsWith("http://"))) {
        return@AsyncFunction false
      }
      val c = ctx
      val existing = ChatTransferStore.get(c, id)
      val est = existing?.optString("state")
      if (existing != null && (est == "running" || est == "queued")) {
        ChatTransferWorker.enqueue(c, id, ExistingWorkPolicy.KEEP)
        return@AsyncFunction true
      }
      if (existing != null && est == "done" && existing.optString("dest") == dest) {
        val p = if (dest.startsWith("file://")) (android.net.Uri.parse(dest).path ?: dest.removePrefix("file://")) else dest
        if (File(p).exists()) {
          ChatTransferEvents.emit("onTransferDone", ChatTransferStore.publicView(existing))
          return@AsyncFunction true
        }
      }
      val rec = JSONObject()
        .put("id", id)
        .put("kind", "download")
        .put("state", "running")
        .put("progress", 0.0)
        .put("url", url)
        .put("dest", dest)
        .put("title", spec["title"] as? String ?: "")
        .put("createdAt", System.currentTimeMillis().toDouble() / 1000.0)
      (spec["headers"] as? Map<*, *>)?.let { h ->
        val o = JSONObject()
        for ((k, v) in h) if (k is String && v is String) o.put(k, v)
        rec.put("headers", o)
      }
      ChatTransferStore.put(c, rec)
      ChatTransferWorker.enqueue(c, id, ExistingWorkPolicy.REPLACE)
      true
    }

    AsyncFunction("getTransfer") { id: String ->
      val rec = ChatTransferStore.get(ctx, id) ?: return@AsyncFunction null
      ChatTransferStore.publicView(rec)
    }

    AsyncFunction("listTransfers") {
      ChatTransferStore.all(ctx).map { ChatTransferStore.publicView(it) }
    }

    AsyncFunction("cancel") { id: String ->
      val c = ctx
      ChatTransferWorker.cancelWork(c, id)
      val rec = ChatTransferStore.update(c, id) { r ->
        val st = r.optString("state")
        if (st == "running" || st == "queued") {
          r.put("state", "cancelled")
          r.remove("bearer")
        }
      }
      if (rec != null) ChatTransferEvents.emit("onTransferDone", ChatTransferStore.publicView(rec))
      Unit
    }

    AsyncFunction("forget") { id: String ->
      val c = ctx
      ChatTransferWorker.cancelWork(c, id)
      ChatTransferStore.remove(c, id)
      Unit
    }

    AsyncFunction("updateBearer") { bearer: String ->
      if (bearer.isNotEmpty()) {
        val c = ctx
        for (r in ChatTransferStore.all(c)) {
          val st = r.optString("state")
          if (r.optString("kind") == "upload" && (st == "running" || st == "queued")) {
            ChatTransferStore.update(c, r.optString("id")) { it.put("bearer", bearer) }
          }
        }
      }
      Unit
    }

    // Foreground resume: make sure every running record has its worker.
    AsyncFunction("kick") {
      val c = ctx
      for (r in ChatTransferStore.all(c)) {
        val st = r.optString("state")
        if (st == "running" || st == "queued") ChatTransferWorker.enqueue(c, r.optString("id"), ExistingWorkPolicy.KEEP)
      }
      Unit
    }
  }
}
