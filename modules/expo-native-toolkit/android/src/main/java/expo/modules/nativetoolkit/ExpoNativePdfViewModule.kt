package expo.modules.nativetoolkit

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import android.util.LruCache
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * [2026-10-07 native-docs-mail] Native PDF viewer for Android.
 *
 * Same JS contract as the iOS PDFKit view (`ExpoNativePdfView`):
 *   props:  uri (http(s) / file:// / content:// / absolute path), headers (auth
 *           headers for the download), page (0-based initial page),
 *           showThumbnails (accepted, no-op on Android)
 *   events: onLoad({pageCount}), onError({message}), onPageChange({page, pageCount})
 *
 * Remote PDFs are downloaded once into cacheDir/chatyy-pdf/<sha1>.pdf (key = full
 * URL + headers, never shared across accounts; 3-day prune) and rendered with
 * android.graphics.pdf.PdfRenderer into a RecyclerView of page bitmaps. Pages
 * are rendered lazily on a single worker thread (PdfRenderer is not thread
 * safe) at the view's width and kept in a memory-bounded LruCache.
 *
 * Before this view, Android attachments went to docs.google.com/viewer (the
 * attachment URL — with its auth token — was handed to Google).
 */
class ExpoNativePdfViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoNativePdfView")

    View(NativePdfView::class) {
      Events("onLoad", "onError", "onPageChange")

      Prop("uri") { view: NativePdfView, value: String? ->
        view.pendingUri = value
      }
      Prop("headers") { view: NativePdfView, value: Map<String, String>? ->
        view.headers = value ?: emptyMap()
      }
      Prop("page") { view: NativePdfView, value: Int? ->
        view.goToPage(value ?: 0)
      }
      Prop("showThumbnails") { _: NativePdfView, _: Boolean? ->
        // iOS-only (PDFThumbnailView). Accepted so the prop set is identical.
      }

      OnViewDidUpdateProps { view: NativePdfView ->
        view.applyProps()
      }

      OnViewDestroys { view: NativePdfView ->
        view.release()
      }
    }
  }
}

class NativePdfView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  companion object {
    private const val TAG = "ExpoNativePdfView"
    private const val MAX_BYTES = 150L * 1024L * 1024L
    private const val MAX_RENDER_WIDTH = 2000
  }

  // RecyclerView needs real Android measure/layout passes (scrolling, item
  // recycling) — let ExpoView forward requestLayout() to measureAndLayout().
  override val shouldUseAndroidLayout: Boolean = true

  private val onLoad by EventDispatcher()
  private val onError by EventDispatcher()
  private val onPageChange by EventDispatcher()

  var pendingUri: String? = null
  var headers: Map<String, String> = emptyMap()

  private var currentUri: String? = null
  private var requestedPage = 0
  private var lastReportedPage = -1
  @Volatile private var generation = 0
  @Volatile private var released = false

  private val mainHandler = Handler(Looper.getMainLooper())
  private val worker: ExecutorService = Executors.newSingleThreadExecutor()
  private val downloader: ExecutorService = Executors.newSingleThreadExecutor()

  // Touched only on the worker thread.
  private var renderer: PdfRenderer? = null
  private var fileDescriptor: ParcelFileDescriptor? = null

  // Main-thread state.
  private var pageSizes: List<IntArray> = emptyList()
  private val inFlight = HashSet<Int>()
  private var renderWidth = 0
  private val bitmapCache: LruCache<Int, Bitmap> = object : LruCache<Int, Bitmap>(
    (Runtime.getRuntime().maxMemory() / 8L).coerceAtMost(96L * 1024L * 1024L).toInt()
  ) {
    override fun sizeOf(key: Int, value: Bitmap): Int = value.byteCount
  }

  private val pageGapPx = (8 * resources.displayMetrics.density).toInt()
  private val layoutManager = LinearLayoutManager(context, LinearLayoutManager.VERTICAL, false)
  private val adapter = PageAdapter()
  private val recycler = RecyclerView(context)

  init {
    recycler.layoutManager = layoutManager
    recycler.adapter = adapter
    recycler.setHasFixedSize(false)
    recycler.overScrollMode = OVER_SCROLL_NEVER
    recycler.clipToPadding = false
    recycler.setPadding(0, pageGapPx, 0, pageGapPx)
    recycler.addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
        reportPage()
      }
    })
    addView(recycler, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w > 0 && w != oldw) {
      renderWidth = 0
      bitmapCache.evictAll()
      inFlight.clear()
      if (pageSizes.isNotEmpty()) {
        adapter.notifyDataSetChanged()
      }
    }
  }

  // ─── Props ────────────────────────────────────────────────────────────────

  fun applyProps() {
    val uri = pendingUri
    if (uri.isNullOrEmpty() || uri == currentUri || released) {
      return
    }
    load(uri)
  }

  fun goToPage(index: Int) {
    requestedPage = if (index < 0) 0 else index
    if (pageSizes.isNotEmpty() && requestedPage < pageSizes.size) {
      layoutManager.scrollToPositionWithOffset(requestedPage, 0)
    }
  }

  fun release() {
    released = true
    generation++
    bitmapCache.evictAll()
    try {
      worker.execute { closeRenderer() }
    } catch (e: Exception) {
      // executor already shut down
    }
    worker.shutdown()
    downloader.shutdownNow()
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  private fun load(uri: String) {
    currentUri = uri
    val gen = ++generation
    val hdrs = HashMap(headers)
    pageSizes = emptyList()
    bitmapCache.evictAll()
    inFlight.clear()
    lastReportedPage = -1
    adapter.notifyDataSetChanged()

    try {
      downloader.execute {
        var file: File? = null
        var error: String? = null
        try {
          file = resolveFile(uri, hdrs)
        } catch (e: Exception) {
          error = e.message ?: e.javaClass.simpleName
        }
        val resolved = file
        if (resolved == null) {
          postError(gen, error ?: "load_failed")
        } else {
          openOnWorker(gen, resolved, isCacheFile(resolved))
        }
      }
    } catch (e: Exception) {
      postError(gen, "executor_closed")
    }
  }

  private fun isCacheFile(file: File): Boolean {
    val dir = File(context.cacheDir, "chatyy-pdf")
    return file.parentFile?.absolutePath == dir.absolutePath
  }

  private fun openOnWorker(gen: Int, file: File, deleteOnFailure: Boolean) {
    try {
      worker.execute {
        if (gen != generation) {
          return@execute
        }
        closeRenderer()
        var sizes: List<IntArray>? = null
        var error: String? = null
        try {
          val pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
          fileDescriptor = pfd
          val r = PdfRenderer(pfd)
          renderer = r
          val list = ArrayList<IntArray>(r.pageCount)
          for (i in 0 until r.pageCount) {
            val page = r.openPage(i)
            list.add(intArrayOf(page.width, page.height))
            page.close()
          }
          sizes = list
        } catch (e: SecurityException) {
          error = "locked"
        } catch (e: Exception) {
          error = e.message ?: "invalid_pdf"
        }
        val result = sizes
        if (result == null || result.isEmpty()) {
          closeRenderer()
          if (deleteOnFailure) {
            file.delete()
          }
          postError(gen, error ?: "empty_pdf")
        } else {
          mainHandler.post {
            if (gen == generation && !released) {
              pageSizes = result
              adapter.notifyDataSetChanged()
              if (requestedPage in result.indices && requestedPage > 0) {
                layoutManager.scrollToPositionWithOffset(requestedPage, 0)
              }
              onLoad(mapOf("pageCount" to result.size))
              reportPage()
            }
          }
        }
      }
    } catch (e: Exception) {
      postError(gen, "executor_closed")
    }
  }

  private fun closeRenderer() {
    try {
      renderer?.close()
    } catch (e: Exception) {
      // ignore
    }
    renderer = null
    try {
      fileDescriptor?.close()
    } catch (e: Exception) {
      // ignore
    }
    fileDescriptor = null
  }

  private fun postError(gen: Int, message: String) {
    Log.w(TAG, "pdf load failed: $message")
    mainHandler.post {
      if (gen == generation && !released) {
        onError(mapOf("message" to message))
      }
    }
  }

  // Full URL (auth query params included) + headers: stripping the token would
  // let two accounts on one device share a cached attachment (same
  // uid/folder/part) — cross-account leak.
  private fun cacheKey(uri: String, hdrs: Map<String, String>): String {
    val sb = StringBuilder(uri)
    for (k in hdrs.keys.sorted()) {
      sb.append('\n').append(k.lowercase()).append(':').append(hdrs[k] ?: "")
    }
    val digest = MessageDigest.getInstance("SHA-1").digest(sb.toString().toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun pruneCache(dir: File, keep: File) {
    try {
      val cutoff = System.currentTimeMillis() - 3L * 24L * 3600L * 1000L
      val items = dir.listFiles() ?: return
      for (f in items) {
        if (f.name != keep.name && f.lastModified() < cutoff) {
          f.delete()
        }
      }
    } catch (e: Exception) {
      // best effort
    }
  }

  @Throws(IOException::class)
  private fun resolveFile(uri: String, hdrs: Map<String, String>): File {
    if (uri.startsWith("file://")) {
      val path = Uri.parse(uri).path ?: throw IOException("bad_file_uri")
      return File(path)
    }
    if (uri.startsWith("/")) {
      return File(uri)
    }
    val dir = File(context.cacheDir, "chatyy-pdf")
    if (!dir.exists()) {
      dir.mkdirs()
    }
    val out = File(dir, cacheKey(uri, hdrs) + ".pdf")
    pruneCache(dir, out)
    if (out.exists() && out.length() > 0L) {
      return out
    }
    val tmp = File(dir, out.name + "." + System.nanoTime() + ".part")
    if (uri.startsWith("content://")) {
      val input = context.contentResolver.openInputStream(Uri.parse(uri))
        ?: throw IOException("content_unavailable")
      input.use { copyLimited(it, tmp) }
    } else if (uri.startsWith("http://") || uri.startsWith("https://")) {
      download(uri, hdrs, tmp)
    } else {
      throw IOException("unsupported_uri")
    }
    if (!tmp.renameTo(out)) {
      tmp.delete()
      throw IOException("cache_write_failed")
    }
    return out
  }

  @Throws(IOException::class)
  private fun download(uri: String, hdrs: Map<String, String>, dest: File) {
    var current = uri
    var redirects = 0
    while (true) {
      val conn = URL(current).openConnection() as HttpURLConnection
      try {
        conn.connectTimeout = 15000
        conn.readTimeout = 60000
        conn.instanceFollowRedirects = false
        conn.setRequestProperty("Accept", "application/pdf,*/*")
        for ((k, v) in hdrs) {
          conn.setRequestProperty(k, v)
        }
        val code = conn.responseCode
        if (code in 300..399) {
          val location = conn.getHeaderField("Location") ?: throw IOException("http_$code")
          redirects++
          if (redirects > 5) {
            throw IOException("too_many_redirects")
          }
          current = URL(URL(current), location).toString()
          continue
        }
        if (code !in 200..299) {
          throw IOException("http_$code")
        }
        val declared = conn.contentLengthLong
        if (declared > MAX_BYTES) {
          throw IOException("too_large")
        }
        conn.inputStream.use { copyLimited(it, dest) }
        return
      } finally {
        conn.disconnect()
      }
    }
  }

  @Throws(IOException::class)
  private fun copyLimited(input: InputStream, dest: File) {
    var total = 0L
    var ok = false
    try {
      FileOutputStream(dest).use { output ->
        val buf = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buf)
          if (n < 0) {
            break
          }
          total += n
          if (total > MAX_BYTES) {
            throw IOException("too_large")
          }
          output.write(buf, 0, n)
        }
      }
      if (total <= 0L) {
        throw IOException("empty")
      }
      ok = true
    } finally {
      if (!ok) {
        dest.delete()
      }
    }
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private fun targetWidth(): Int {
    if (renderWidth > 0) {
      return renderWidth
    }
    var w = recycler.width
    if (w <= 0) {
      w = width
    }
    if (w <= 0) {
      w = resources.displayMetrics.widthPixels
    }
    renderWidth = w.coerceAtMost(MAX_RENDER_WIDTH)
    return renderWidth
  }

  private fun pageHeightFor(position: Int, w: Int): Int {
    val size = pageSizes.getOrNull(position) ?: return w
    if (size[0] <= 0) {
      return w
    }
    return (w.toLong() * size[1] / size[0]).toInt().coerceAtLeast(1)
  }

  private fun requestRender(position: Int) {
    if (inFlight.contains(position) || released) {
      return
    }
    val w = targetWidth()
    val h = pageHeightFor(position, w)
    val gen = generation
    inFlight.add(position)
    try {
      worker.execute {
        var bmp: Bitmap? = null
        if (gen == generation) {
          val r = renderer
          if (r != null && position < r.pageCount) {
            try {
              val page = r.openPage(position)
              try {
                val b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                b.eraseColor(Color.WHITE)
                page.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bmp = b
              } finally {
                page.close()
              }
            } catch (e: Throwable) {
              Log.w(TAG, "render page $position failed: ${e.message}")
            }
          }
        }
        val result = bmp
        mainHandler.post {
          inFlight.remove(position)
          if (gen == generation && result != null && !released && result.width == targetWidth()) {
            bitmapCache.put(position, result)
            adapter.notifyItemChanged(position)
          }
        }
      }
    } catch (e: Exception) {
      inFlight.remove(position)
    }
  }

  private fun reportPage() {
    val count = pageSizes.size
    if (count == 0) {
      return
    }
    var p = layoutManager.findFirstVisibleItemPosition()
    val completely = layoutManager.findFirstCompletelyVisibleItemPosition()
    if (completely != RecyclerView.NO_POSITION) {
      p = completely
    }
    if (p == RecyclerView.NO_POSITION) {
      p = 0
    }
    if (p == lastReportedPage) {
      return
    }
    lastReportedPage = p
    onPageChange(mapOf("page" to p, "pageCount" to count))
  }

  private class PageHolder(val image: ImageView) : RecyclerView.ViewHolder(image)

  private inner class PageAdapter : RecyclerView.Adapter<PageHolder>() {
    override fun getItemCount(): Int = pageSizes.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PageHolder {
      val iv = ImageView(parent.context)
      iv.scaleType = ImageView.ScaleType.FIT_XY
      iv.setBackgroundColor(Color.WHITE)
      return PageHolder(iv)
    }

    override fun onBindViewHolder(holder: PageHolder, position: Int) {
      val w = targetWidth()
      val lp = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, pageHeightFor(position, w))
      lp.bottomMargin = if (position == pageSizes.size - 1) 0 else pageGapPx
      holder.image.layoutParams = lp
      holder.image.contentDescription = "Page ${position + 1}"
      val cached = bitmapCache.get(position)
      holder.image.setImageBitmap(cached)
      if (cached == null) {
        requestRender(position)
      }
    }
  }
}
