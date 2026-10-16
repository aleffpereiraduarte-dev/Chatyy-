package expo.modules.nativetoolkit

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// [2026-10-09 native-docs] System document "open with" (JS: utils/openDocument.js).
//
//   canPreview(path, mime) → true when some installed app handles ACTION_VIEW for
//                            this mime (best effort; Android 11+ package
//                            visibility may hide apps → JS still tries preview()).
//   preview(path, mime, title) → ACTION_VIEW through expo-file-system's
//                            FileProvider (authority <pkg>.FileSystemFileProvider,
//                            cache-path + files-path), FLAG_GRANT_READ_URI_PERMISSION.
//                            Resolves false when nothing
//                            can open it (JS falls back to the share sheet).
//
// Replaces the docs.google.com embedded viewer: the file never leaves the device.
class ExpoChatyyDocPreviewModule : Module() {
  private fun toFile(path: String): File? {
    if (path.isEmpty()) return null
    val p = if (path.startsWith("file://")) Uri.parse(path).path else if (path.startsWith("/")) path else null
    if (p.isNullOrEmpty()) return null
    val f = File(p)
    return if (f.exists() && f.isFile) f else null
  }

  private fun mimeFor(file: File, mime: String?): String {
    if (!mime.isNullOrBlank() && mime.contains('/')) return mime
    val ext = file.extension.lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoChatyyDocPreview")

    Function("canPreview") { path: String, mime: String? ->
      try {
        val ctx = appContext.reactContext ?: return@Function false
        val file = toFile(path) ?: return@Function false
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".FileSystemFileProvider", file)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeFor(file, mime))
        intent.resolveActivity(ctx.packageManager) != null
      } catch (_: Throwable) {
        false
      }
    }

    // [2026-10-16 drive-native] 2 = tem saveToDownloads. JS: services/driveFileActions.js
    Function("apiVersion") { 2 }

    // Copia o arquivo local para Downloads (MediaStore, Android 10+; sem permissão).
    // Resolve true se salvou; false em Android < 10 ou erro (JS cai no compartilhar).
    AsyncFunction("saveToDownloads") { path: String, name: String?, mime: String? ->
      try {
        val ctx = appContext.reactContext ?: return@AsyncFunction false
        val file = toFile(path) ?: return@AsyncFunction false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@AsyncFunction false
        val display = (name?.takeIf { it.isNotBlank() } ?: file.name).replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val values = ContentValues().apply {
          put(MediaStore.MediaColumns.DISPLAY_NAME, display)
          put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(file, mime))
          put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Chatyy")
          put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = ctx.contentResolver
        val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return@AsyncFunction false
        try {
          resolver.openOutputStream(target)?.use { out ->
            file.inputStream().use { input -> input.copyTo(out, 256 * 1024) }
          } ?: throw IllegalStateException("no stream")
          val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
          resolver.update(target, done, null, null)
          true
        } catch (t: Throwable) {
          try { resolver.delete(target, null, null) } catch (_: Throwable) {}
          false
        }
      } catch (_: Throwable) {
        false
      }
    }

    AsyncFunction("preview") { path: String, mime: String?, title: String? ->
      try {
        val ctx = appContext.reactContext ?: return@AsyncFunction false
        val file = toFile(path) ?: return@AsyncFunction false
        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".FileSystemFileProvider", file)
        val view = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, mimeFor(file, mime))
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        // Started directly (not via createChooser): startActivity is not subject
        // to Android 11+ package-visibility filtering, and with no handler it
        // throws ActivityNotFoundException → false → JS share-sheet fallback.
        // With several handlers the system shows its own "Open with" picker.
        val activity = appContext.currentActivity
        if (activity != null) {
          activity.startActivity(view)
        } else {
          view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          ctx.startActivity(view)
        }
        true
      } catch (_: ActivityNotFoundException) {
        false
      } catch (_: Throwable) {
        false
      }
    }
  }
}
