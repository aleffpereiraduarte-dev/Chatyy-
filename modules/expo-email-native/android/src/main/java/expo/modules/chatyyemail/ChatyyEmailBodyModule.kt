package expo.modules.chatyyemail

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * [2026-10-15 native-email] Corpo do e-mail NATIVO (Android). Mesmo contrato
 * do iOS (ios/ChatyyEmailBodyModule.swift):
 *
 * Props:  html, blockRemote, allowHosts[], appearance, bgColor, labels
 * Eventos: onContentHeight {height}, onLinkPress {url}, onLinkLongPress {url},
 *          onFirstPaint {ms}, onZoomChange {zoomed, scale}
 * Métodos: resetZoom()
 *
 * WebView dedicado: sem acesso a arquivo/conteúdo, sem janelas, sem cookies de
 * terceiros, sem DOM storage. O JS do e-mail é barrado pela CSP do <head>
 * (script-src 'none', montada no JS) e o sanitizador já remove <script>; o JS
 * fica ligado só para o NOSSO evaluateJavascript (medida/ajuste de largura), que
 * não passa pela CSP da página. Conteúdo remoto: shouldInterceptRequest devolve
 * vazio para http(s) fora de `allowHosts` enquanto blockRemote = true.
 */
class ChatyyEmailBodyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyEmailBody")

    Function("apiVersion") { 1 }

    View(ChatyyEmailBodyView::class) {
      Events("onContentHeight", "onLinkPress", "onLinkLongPress", "onFirstPaint", "onZoomChange")

      Prop("html") { view: ChatyyEmailBodyView, v: String? -> view.pendingHtml = v ?: "" }
      Prop("blockRemote") { view: ChatyyEmailBodyView, v: Boolean? -> view.pendingBlock = v ?: true }
      Prop("allowHosts") { view: ChatyyEmailBodyView, v: List<String>? -> view.pendingHosts = v ?: emptyList() }
      Prop("appearance") { view: ChatyyEmailBodyView, v: String? -> view.appearance = v ?: "light" }
      Prop("bgColor") { view: ChatyyEmailBodyView, v: Double? -> view.bgColor = v }
      Prop("labels") { view: ChatyyEmailBodyView, v: Map<String, String>? -> view.labels = v ?: emptyMap() }

      OnViewDidUpdateProps { view: ChatyyEmailBodyView -> view.applyProps() }

      AsyncFunction("resetZoom") { view: ChatyyEmailBodyView -> view.resetZoom() }.runOnQueue(Queues.MAIN)
    }
  }
}

/** WebView que avisa quando a altura do conteúdo pode ter mudado e solta o
 *  gesto para o ScrollView pai, exceto em pinça/zoom. */
@SuppressLint("ViewConstructor")
internal class CEBWebView(ctx: Context) : WebView(ctx) {
  var onContentMaybeChanged: (() -> Unit)? = null
  @Volatile var zoomed = false
  private var lastContentH = -1

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val ch = contentHeight
    if (ch != lastContentH) {
      lastContentH = ch
      onContentMaybeChanged?.invoke()
    }
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (ev.pointerCount > 1 || zoomed) parent?.requestDisallowInterceptTouchEvent(true)
    return super.dispatchTouchEvent(ev)
  }
}

@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
class ChatyyEmailBodyView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout: Boolean = true

  internal val onContentHeight by EventDispatcher()
  internal val onLinkPress by EventDispatcher()
  internal val onLinkLongPress by EventDispatcher()
  internal val onFirstPaint by EventDispatcher()
  internal val onZoomChange by EventDispatcher()

  var pendingHtml: String = ""
  var pendingBlock: Boolean = true
  var pendingHosts: List<String> = emptyList()
  var appearance: String = "light"
  var bgColor: Double? = null
  var labels: Map<String, String> = emptyMap()

  @Volatile private var blockNow = true
  @Volatile private var hostsNow: List<String> = emptyList()

  private val main = Handler(Looper.getMainLooper())
  private var web: CEBWebView = makeWebView()
  private var loadedHtml: String? = null
  private var loadedBlock: Boolean? = null
  private var loadedHosts: List<String> = emptyList()
  private var loadGen = 0
  private var loadStart = 0L
  private var firstPaintSent = false
  private var lastHeight = -1
  private var baseScale = 0f
  private var zoomedState = false
  private val density = resources.displayMetrics.density

  private val measureRunnable = Runnable { measureNow() }

  init {
    setBackgroundColor(Color.TRANSPARENT)
    addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }

  private fun makeWebView(): CEBWebView {
    val w = CEBWebView(context)
    w.setBackgroundColor(Color.TRANSPARENT)
    w.isVerticalScrollBarEnabled = false
    w.isHorizontalScrollBarEnabled = false
    w.overScrollMode = OVER_SCROLL_NEVER
    w.isFocusable = true
    w.isFocusableInTouchMode = false
    w.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = false
      allowFileAccess = false
      allowContentAccess = false
      @Suppress("DEPRECATION")
      allowFileAccessFromFileURLs = false
      @Suppress("DEPRECATION")
      allowUniversalAccessFromFileURLs = false
      setSupportMultipleWindows(false)
      javaScriptCanOpenWindowsAutomatically = false
      setSupportZoom(true)
      builtInZoomControls = true
      displayZoomControls = false
      useWideViewPort = true
      loadWithOverviewMode = false
      textZoom = 100
      mediaPlaybackRequiresUserGesture = true
      setGeolocationEnabled(false)
      mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
      blockNetworkImage = false
    }
    try { CookieManager.getInstance().setAcceptThirdPartyCookies(w, false) } catch (_: Throwable) {}
    w.webViewClient = Client()
    w.onContentMaybeChanged = { scheduleMeasure(80) }
    w.setOnLongClickListener {
      val r = w.hitTestResult
      if (r.type == WebView.HitTestResult.SRC_ANCHOR_TYPE) {
        val u = r.extra
        if (!u.isNullOrEmpty()) {
          onLinkLongPress(mapOf("url" to u))
          return@setOnLongClickListener true
        }
      }
      false
    }
    return w
  }

  fun applyProps() {
    val bg = bgColor
    setBackgroundColor(if (bg != null && !bg.isNaN()) bg.toLong().toInt() else Color.TRANSPARENT)
    val html = pendingHtml
    if (html == loadedHtml && loadedBlock == pendingBlock && loadedHosts == pendingHosts) return
    load(html)
  }

  fun resetZoom() {
    try { while (web.zoomOut()) { /* até o mínimo */ } } catch (_: Throwable) {}
  }

  private fun load(html: String) {
    loadGen += 1
    loadedHtml = html
    loadedBlock = pendingBlock
    loadedHosts = pendingHosts
    blockNow = pendingBlock
    hostsNow = pendingHosts.map { it.lowercase().trim() }.filter { it.isNotEmpty() }
    firstPaintSent = false
    lastHeight = -1
    loadStart = SystemClock.elapsedRealtime()
    web.settings.blockNetworkImage = false
    web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
  }

  private fun hostAllowed(host: String?): Boolean {
    val h = host?.lowercase() ?: return false
    for (a in hostsNow) {
      if (h == a || h.endsWith(".$a")) return true
    }
    return false
  }

  private fun scheduleMeasure(delayMs: Long) {
    main.removeCallbacks(measureRunnable)
    main.postDelayed(measureRunnable, delayMs)
  }

  private fun measureNow() {
    val gen = loadGen
    try {
      web.evaluateJavascript(MEASURE_JS) { res ->
        if (gen != loadGen) return@evaluateJavascript
        var h = 0.0
        try {
          if (res != null && res != "null" && res != "\"\"") {
            val s = JSONArray("[$res]").getString(0)
            if (s.isNotEmpty()) h = JSONObject(s).optDouble("h", 0.0)
          }
        } catch (_: Throwable) {}
        // Sem resposta do script → altura do documento (CSS px).
        if (!(h > 0.0) || h.isNaN()) h = web.contentHeight.toDouble()
        if (h > 0.0) emitHeight(Math.ceil(h).toInt())
      }
    } catch (_: Throwable) {
      val h = web.contentHeight
      if (h > 0) emitHeight(h)
    }
  }

  private fun emitHeight(h: Int) {
    // Com zoom de pinça a altura do layout não muda; ignora a medida.
    if (zoomedState) return
    if (Math.abs(h - lastHeight) >= 1) {
      lastHeight = h
      onContentHeight(mapOf("height" to h.toDouble()))
    }
    if (!firstPaintSent) {
      firstPaintSent = true
      onFirstPaint(mapOf("ms" to (SystemClock.elapsedRealtime() - loadStart).toDouble()))
    }
  }

  private inner class Client : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val u = request.url?.toString() ?: return true
      if (u.startsWith("about:")) return false
      if (request.isForMainFrame) {
        main.post { onLinkPress(mapOf("url" to u)) }
      }
      return true
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
      val uri: Uri = request.url ?: return null
      val scheme = uri.scheme?.lowercase()
      if (scheme == "http" || scheme == "https") {
        if (blockNow && !hostAllowed(uri.host)) {
          return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }
        return null
      }
      if (scheme == "file" || scheme == "content") {
        return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
      }
      return null
    }

    override fun onPageFinished(view: WebView, url: String?) {
      scheduleMeasure(0)
      scheduleLater(250)
      scheduleLater(900)
      scheduleLater(2000)
    }

    override fun onLoadResource(view: WebView, url: String?) {
      scheduleMeasure(150)
    }

    override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) {
      if (baseScale <= 0f) baseScale = if (oldScale > 0f) oldScale else density
      val z = newScale > baseScale * 1.02f
      web.zoomed = z
      if (z != zoomedState) {
        zoomedState = z
        onZoomChange(mapOf("zoomed" to z, "scale" to (newScale / baseScale).toDouble()))
        if (!z) scheduleMeasure(120)
      }
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail?): Boolean {
      // Renderer morreu (memória): troca o WebView e recarrega o mesmo HTML.
      main.post { rebuild() }
      return true
    }
  }

  private fun scheduleLater(ms: Long) {
    val gen = loadGen
    main.postDelayed({ if (gen == loadGen) measureNow() }, ms)
  }

  private fun rebuild() {
    try {
      removeView(web)
      web.destroy()
    } catch (_: Throwable) {}
    web = makeWebView()
    addView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    loadedHtml = null
    applyProps()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    main.removeCallbacksAndMessages(null)
  }

  companion object {
    // Mesmo script do iOS (sem postMessage: devolve o JSON no evaluateJavascript).
    internal const val MEASURE_JS = """
(function(){
  if (!window.__cyMeasure) {
    var fitW = 0;
    var measure = function(){
      var b = document.body; if (!b) return null;
      var clip = document.getElementById('cy-clip'), root = document.getElementById('cy-root');
      if (clip && root) {
        var avail = clip.clientWidth;
        var nw = root.scrollWidth;
        if (avail > 0 && nw > Math.max(avail, fitW) + 2) {
          fitW = nw;
          var z = Math.max(0.3, avail / nw);
          root.style.width = nw + 'px';
          root.style.transformOrigin = '0 0';
          root.style.transform = 'scale(' + z + ')';
          root.setAttribute('data-cy-z', String(z));
        }
        var zz = parseFloat(root.getAttribute('data-cy-z') || '1') || 1;
        if (zz !== 1) clip.style.height = Math.ceil(root.offsetHeight * zz) + 'px';
      }
      var cs = getComputedStyle(b);
      var h = b.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      return { h: h, w: document.documentElement.scrollWidth };
    };
    window.__cyMeasure = function(){ var r = measure(); return r ? JSON.stringify(r) : ''; };
  }
  return window.__cyMeasure();
})()
"""
  }
}
