package expo.modules.nativetoolkit

import android.content.Context
import android.net.Uri
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.MimeTypeMap
import android.widget.EditText
import androidx.core.view.ContentInfoCompat
import androidx.core.view.OnReceiveContentListener
import androidx.core.view.ViewCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

/**
 * [2026-10-10 paste-image] Colar foto/GIF/figurinha no campo de mensagem.
 *
 * ViewCompat.setOnReceiveContentListener no ReactEditText do composer:
 *  • GIF/figurinha do teclado (Gboard commitContent) — o AppCompatEditText
 *    anuncia os MIME types ao IME (EditorInfo.contentMimeTypes);
 *  • "Colar" do menu do campo com imagem na área de transferência.
 * O conteúdo com URI de imagem vira arquivo no cache e sai no evento
 * onImagePasted { uri, mimeType, size, viewTag }. Texto segue o caminho padrão
 * (devolvemos o "remaining" ao EditText).
 */
class ChatyyImagePasteModule : Module() {

  companion object {
    private const val TAG = "ChatyyImagePaste"
    private val MIME_TYPES = arrayOf("image/*")
    private const val MAX_BYTES = 40L * 1024L * 1024L
  }

  override fun definition() = ModuleDefinition {
    Name("ChatyyImagePaste")
    Events("onImagePasted")

    Function("isSupported") { true }

    AsyncFunction("attach") { viewTag: Int ->
      val root = appContext.findView<View>(viewTag) ?: return@AsyncFunction false
      val edit = findEditText(root, 0) ?: return@AsyncFunction false
      ViewCompat.setOnReceiveContentListener(edit, MIME_TYPES, makeListener(viewTag))
      // Campo já focado: reinicia a conexão com o teclado para ele ver os MIME types.
      if (edit.hasFocus()) {
        try {
          (edit.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.restartInput(edit)
        } catch (_: Throwable) {}
      }
      true
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("detach") { viewTag: Int ->
      val root = appContext.findView<View>(viewTag) ?: return@AsyncFunction false
      val edit = findEditText(root, 0) ?: return@AsyncFunction false
      ViewCompat.setOnReceiveContentListener(edit, null, null)
      true
    }.runOnQueue(Queues.MAIN)
  }

  private fun findEditText(view: View, depth: Int): EditText? {
    if (view is EditText) return view
    if (depth > 4 || view !is ViewGroup) return null
    for (i in 0 until view.childCount) {
      val found = findEditText(view.getChildAt(i), depth + 1)
      if (found != null) return found
    }
    return null
  }

  private fun makeListener(viewTag: Int) = OnReceiveContentListener { view, payload ->
    val ctx = view.context
    val split = payload.partition { item -> item.uri != null }
    val withUri: ContentInfoCompat? = split.first
    val remaining: ContentInfoCompat? = split.second
    var notHandled: ContentInfoCompat? = remaining
    if (withUri != null) {
      val clip = withUri.clip
      var handledAny = false
      for (i in 0 until clip.itemCount) {
        val uri = clip.getItemAt(i).uri ?: continue
        val resolved: String? = try { ctx.contentResolver.getType(uri) } catch (_: Throwable) { null }
        val mime: String = resolved ?: guessMime(uri)
        if (!mime.startsWith("image/")) continue
        val out = copyToCache(ctx, uri, mime)
        if (out != null) {
          handledAny = true
          try {
            sendEvent("onImagePasted", mapOf(
              "uri" to Uri.fromFile(out).toString(),
              "mimeType" to mime,
              "size" to out.length(),
              "width" to 0,
              "height" to 0,
              "viewTag" to viewTag
            ))
          } catch (t: Throwable) {
            Log.w(TAG, "sendEvent failed: ${t.message}")
          }
        }
      }
      // Nada útil (não-imagem / falha) → devolve ao EditText para o padrão.
      if (!handledAny) notHandled = payload
    }
    notHandled
  }

  private fun guessMime(uri: Uri): String {
    val ext = MimeTypeMap.getFileExtensionFromUrl(uri.toString())?.lowercase() ?: ""
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  private fun copyToCache(ctx: Context, uri: Uri, mime: String): File? {
    return try {
      val ext = when {
        mime.contains("gif") -> "gif"
        mime.contains("webp") -> "webp"
        mime.contains("png") -> "png"
        else -> "jpg"
      }
      val out = File(ctx.cacheDir, "colado_${System.currentTimeMillis()}.$ext")
      var total = 0L
      ctx.contentResolver.openInputStream(uri)?.use { input ->
        FileOutputStream(out).use { output ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > MAX_BYTES) throw IllegalStateException("too large")
            output.write(buf, 0, n)
          }
        }
      } ?: return null
      if (out.length() <= 0L) { out.delete(); null } else out
    } catch (t: Throwable) {
      Log.w(TAG, "copy failed: ${t.message}")
      null
    }
  }
}
