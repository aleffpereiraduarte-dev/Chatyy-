package expo.modules.nativetoolkit

// [2026-10-07 native-maps] Native map view for Android — MapLibre Native
// (org.maplibre.gl:android-sdk) rendering the SAME self-hosted BoraUm vector
// styles the web/WebView path uses. ZERO Google (no Play Services, no Maps SDK).
//
// One view, two modes:
//   - interactive (default): MapLibre MapView (TextureView mode so it composes
//     correctly inside RN Modals / rounded clips) + an overlay FrameLayout of
//     plain Android Views used as markers (avatar/pin/dot/me/search). Overlay
//     views are re-projected on every camera frame (onCameraIsChanging).
//   - lite: an offscreen MapSnapshotter renders ONE bitmap (cached in an LRU,
//     max 2 concurrent snapshotters) shown in an ImageView — used by the chat
//     location bubble so a list of bubbles never spins up N GL surfaces.
//
// JS contract (mirrored 1:1 by ios/ChatyyMapView.swift):
//   props : styleUrl, dark, lite, interactive, rotateEnabled, camera, markers
//   events: onMapReady, onRegionWillChange{gesture}, onRegionDidChange{latitude,
//           longitude,zoom,gesture}, onMarkerPress{id}, onMapPress{latitude,
//           longitude}, onMapError{message}
// Zoom = web-mercator zoom with 512px tiles (identical to MapLibre GL JS).
//
// Kotlin rule of this codebase: statement-form try only (no try-as-expression).

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.snapshotter.MapSnapshot
import org.maplibre.android.snapshotter.MapSnapshotter
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.ArrayDeque
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.tan

// ─── Records ──────────────────────────────────────────────────────────────

class ChatyyMapCamera : Record {
  @Field val latitude: Double = 0.0
  @Field val longitude: Double = 0.0
  @Field val zoom: Double = 15.0
  @Field val animated: Boolean = false
  // JS bumps `seq` to re-apply the camera (recenter); same seq = no-op so
  // re-renders never fight the user's pan.
  @Field val seq: Double = 0.0
  // Optional fit-bounds (all four set → fit instead of center/zoom).
  @Field val minLatitude: Double? = null
  @Field val minLongitude: Double? = null
  @Field val maxLatitude: Double? = null
  @Field val maxLongitude: Double? = null
  @Field val padding: Double = 60.0
  @Field val maxZoom: Double = 16.0
}

class ChatyyMapMarker : Record {
  @Field val id: String = ""
  @Field val latitude: Double = 0.0
  @Field val longitude: Double = 0.0
  // pin | search | dot | live | me | avatar
  @Field val kind: String = "pin"
  @Field val color: String? = null
  @Field val label: String? = null
  @Field val sublabel: String? = null
  @Field val imageUrl: String? = null
  @Field val initials: String? = null
  @Field val stale: Boolean = false
  @Field val highlight: Boolean = false
}

// ─── Module ───────────────────────────────────────────────────────────────

class ChatyyMapViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ChatyyMapView")

    OnActivityEntersForeground { ChatyyMapView.forEachLive { it.onHostResume() } }
    OnActivityEntersBackground { ChatyyMapView.forEachLive { it.onHostPause() } }

    View(ChatyyMapView::class) {
      Events(
        "onMapReady",
        "onRegionWillChange",
        "onRegionDidChange",
        "onMarkerPress",
        "onMapPress",
        "onMapError"
      )
      Prop("styleUrl") { view: ChatyyMapView, v: String? -> view.setStyleUrlProp(v) }
      Prop("dark") { view: ChatyyMapView, v: Boolean? -> view.dark = v ?: false }
      Prop("lite") { view: ChatyyMapView, v: Boolean? -> view.lite = v ?: false }
      Prop("interactive") { view: ChatyyMapView, v: Boolean? -> view.setInteractiveProp(v ?: true) }
      Prop("rotateEnabled") { view: ChatyyMapView, v: Boolean? -> view.rotateEnabled = v ?: false }
      Prop("camera") { view: ChatyyMapView, v: ChatyyMapCamera? -> view.setCameraProp(v) }
      Prop("markers") { view: ChatyyMapView, v: List<ChatyyMapMarker>? -> view.setMarkersProp(v ?: emptyList()) }
      OnViewDidUpdateProps { view: ChatyyMapView -> view.commit() }
      OnViewDestroys { view: ChatyyMapView -> view.destroy() }
    }
  }
}

// ─── View ─────────────────────────────────────────────────────────────────

class ChatyyMapView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

  companion object {
    private const val DEFAULT_STYLE = "https://boraum.com.br/maptiles/styles/world-cinza/style.json"
    private val live = ArrayList<WeakReference<ChatyyMapView>>()
    private val main = Handler(Looper.getMainLooper())

    fun forEachLive(fn: (ChatyyMapView) -> Unit) {
      val it = live.iterator()
      while (it.hasNext()) {
        val v = it.next().get()
        if (v == null) { it.remove(); continue }
        fn(v)
      }
    }

    // Lite snapshots: LRU by bytes (1/16 of the heap) + 2 concurrent renders.
    private val snapCache: LruCache<String, Bitmap> =
      object : LruCache<String, Bitmap>(max(4 * 1024 * 1024, (Runtime.getRuntime().maxMemory() / 16).toInt())) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
      }
    private class SnapJob(val view: WeakReference<ChatyyMapView>, val key: String)
    private val snapQueue = ArrayDeque<SnapJob>()
    private val snapRunning = HashSet<MapSnapshotter>()
    private const val MAX_SNAP = 2

    // Avatar images (shared across every map instance).
    private val imageCache: LruCache<String, Bitmap> =
      object : LruCache<String, Bitmap>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
      }
    private val imageExec = Executors.newFixedThreadPool(2)
    private val imageWaiters = HashMap<String, ArrayList<(Bitmap?) -> Unit>>()

    fun loadImage(url: String, cb: (Bitmap?) -> Unit) {
      val cached = imageCache.get(url)
      if (cached != null) { cb(cached); return }
      val waiting = imageWaiters[url]
      if (waiting != null) { waiting.add(cb); return }
      imageWaiters[url] = arrayListOf(cb)
      imageExec.execute {
        var bmp: Bitmap? = null
        var conn: HttpURLConnection? = null
        try {
          conn = URL(url).openConnection() as HttpURLConnection
          conn.connectTimeout = 8000
          conn.readTimeout = 10000
          conn.instanceFollowRedirects = true
          if (conn.responseCode in 200..299) {
            val raw = conn.inputStream.use { BitmapFactory.decodeStream(it) }
            if (raw != null) {
              val side = 144
              bmp = if (raw.width > side || raw.height > side) Bitmap.createScaledBitmap(raw, side, side, true) else raw
            }
          }
        } catch (_: Throwable) {
          bmp = null
        } finally {
          try { conn?.disconnect() } catch (_: Throwable) {}
        }
        val result = bmp
        main.post {
          if (result != null) imageCache.put(url, result)
          val cbs = imageWaiters.remove(url) ?: arrayListOf()
          for (c in cbs) {
            try { c(result) } catch (_: Throwable) {}
          }
        }
      }
    }

    private fun pumpSnapshots() {
      while (snapRunning.size < MAX_SNAP && snapQueue.isNotEmpty()) {
        val job = snapQueue.poll() ?: break
        val v = job.view.get() ?: continue
        if (v.destroyed || v.snapshotKey != job.key) continue
        val cached = snapCache.get(job.key)
        if (cached != null) { v.showSnapshot(cached); continue }
        v.startSnapshot(job.key)
      }
    }

    fun parseColor(s: String?, fallback: Int): Int {
      if (s.isNullOrBlank()) return fallback
      var c = fallback
      try { c = Color.parseColor(s) } catch (_: Throwable) { c = fallback }
      return c
    }

    // web-mercator normalized coords (0..1)
    fun mercX(lng: Double): Double = (lng + 180.0) / 360.0
    fun mercY(lat: Double): Double {
      val clamped = lat.coerceIn(-85.05112878, 85.05112878)
      val r = clamped * PI / 180.0
      return (1.0 - ln(tan(r) + 1.0 / cos(r)) / PI) / 2.0
    }
  }

  override val shouldUseAndroidLayout: Boolean = true

  val onMapReady by EventDispatcher()
  val onRegionWillChange by EventDispatcher()
  val onRegionDidChange by EventDispatcher()
  val onMarkerPress by EventDispatcher()
  val onMapPress by EventDispatcher()
  val onMapError by EventDispatcher()

  private val density = resources.displayMetrics.density
  private val root = FrameLayout(context)
  private val snapshotView = ImageView(context)
  private val markersLayer = FrameLayout(context)
  private var mapView: MapView? = null
  private var map: MapLibreMap? = null

  var dark = false
  var lite = false
  var rotateEnabled = false
  private var interactive = true
  private var styleUrl: String = DEFAULT_STYLE
  private var appliedStyle: String? = null
  private var camera: ChatyyMapCamera? = null
  private var appliedSeq: Double = Double.NaN
  private var cameraDirty = false
  private var markerRecords: List<ChatyyMapMarker> = emptyList()
  private var markersDirty = false
  private val holders = LinkedHashMap<String, MarkerHolder>()

  internal var destroyed = false
  private var started = false
  private var resumed = false
  private var hostPaused = false
  private var ready = false
  private var gestureMove = false
  internal var snapshotKey: String? = null
  private var snapshotter: MapSnapshotter? = null
  // camera used for the snapshot currently displayed (lite marker projection)
  private var liteLat = 0.0
  private var liteLng = 0.0
  private var liteZoom = 15.0

  private inner class MarkerHolder(var record: ChatyyMapMarker, val view: View) {
    var lat = record.latitude
    var lng = record.longitude
    var anchorX = 0f
    var anchorY = 0f
    var anim: ValueAnimator? = null
    var pulse: ValueAnimator? = null
    var signature = ""
  }

  init {
    clipChildren = true
    addView(root, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    snapshotView.scaleType = ImageView.ScaleType.CENTER_CROP
    snapshotView.visibility = View.GONE
    root.addView(snapshotView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root.addView(markersLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    live.add(WeakReference(this))
  }

  // ── props ───────────────────────────────────────────────────────────────

  fun setStyleUrlProp(v: String?) {
    styleUrl = if (v.isNullOrBlank()) DEFAULT_STYLE else v
  }

  fun setInteractiveProp(v: Boolean) {
    interactive = v
    val m = map
    if (m != null) applyGestures(m)
  }

  fun setCameraProp(v: ChatyyMapCamera?) {
    camera = v
    if (v == null) return
    if (appliedSeq.isNaN() || v.seq != appliedSeq) cameraDirty = true
  }

  fun setMarkersProp(v: List<ChatyyMapMarker>) {
    markerRecords = v
    markersDirty = true
  }

  fun commit() {
    if (destroyed) return
    if (lite) {
      snapshotView.visibility = View.VISIBLE
      ensureSnapshot()
    } else {
      snapshotView.visibility = View.GONE
      ensureMap()
      val m = map
      if (m != null) {
        applyGestures(m)
        applyStyle(m)
        if (cameraDirty) applyCamera(m)
      }
    }
    if (markersDirty) {
      markersDirty = false
      syncMarkers()
    }
  }

  // ── interactive map ─────────────────────────────────────────────────────

  private fun ensureMap() {
    if (mapView != null || destroyed) return
    try {
      MapLibre.getInstance(context.applicationContext)
    } catch (e: Throwable) {
      onMapError(mapOf("message" to ("init: " + (e.message ?: "error"))))
      return
    }
    val opts = MapLibreMapOptions.createFromAttributes(context)
      .textureMode(true)
      .logoEnabled(false)
      .attributionEnabled(false)
      .compassEnabled(rotateEnabled)
      .rotateGesturesEnabled(rotateEnabled)
      .tiltGesturesEnabled(false)
    val cam = camera
    if (cam != null && !hasBounds(cam)) {
      opts.camera(CameraPosition.Builder().target(LatLng(cam.latitude, cam.longitude)).zoom(cam.zoom).build())
      appliedSeq = cam.seq
      cameraDirty = false
    }
    val mv = MapView(context, opts)
    mv.onCreate(null)
    root.addView(mv, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    mapView = mv
    mv.addOnCameraIsChangingListener { repositionAll() }
    mv.addOnCameraDidChangeListener { _ -> repositionAll() }
    mv.addOnDidFailLoadingMapListener { msg -> onMapError(mapOf("message" to (msg ?: "load failed"))) }
    mv.getMapAsync { m -> onMapAvailable(m) }
    if (isAttachedToWindow) startMap()
  }

  private fun onMapAvailable(m: MapLibreMap) {
    if (destroyed) return
    map = m
    applyGestures(m)
    m.addOnCameraMoveStartedListener { reason ->
      gestureMove = reason == MapLibreMap.OnCameraMoveStartedListener.REASON_API_GESTURE
      onRegionWillChange(mapOf("gesture" to gestureMove))
    }
    m.addOnCameraIdleListener { emitRegion() }
    m.addOnMapClickListener { ll ->
      onMapPress(mapOf("latitude" to ll.latitude, "longitude" to ll.longitude))
      false
    }
    applyStyle(m)
    if (cameraDirty) applyCamera(m)
    repositionAll()
  }

  private fun applyGestures(m: MapLibreMap) {
    val ui = m.uiSettings
    ui.setAllGesturesEnabled(interactive)
    ui.setRotateGesturesEnabled(interactive && rotateEnabled)
    ui.setTiltGesturesEnabled(false)
    ui.setCompassEnabled(rotateEnabled)
    ui.setLogoEnabled(false)
    ui.setAttributionEnabled(false)
  }

  private fun applyStyle(m: MapLibreMap) {
    if (appliedStyle == styleUrl) return
    appliedStyle = styleUrl
    m.setStyle(Style.Builder().fromUri(styleUrl)) { _ ->
      if (!destroyed && !ready) {
        ready = true
        onMapReady(mapOf("lite" to false))
      }
      repositionAll()
    }
  }

  private fun hasBounds(c: ChatyyMapCamera): Boolean =
    c.minLatitude != null && c.minLongitude != null && c.maxLatitude != null && c.maxLongitude != null

  private fun applyCamera(m: MapLibreMap) {
    val cam = camera ?: return
    val mv = mapView ?: return
    if (hasBounds(cam) && (mv.width <= 0 || mv.height <= 0)) return // retried in onSizeChanged
    cameraDirty = false
    appliedSeq = cam.seq
    val minLat = cam.minLatitude
    val minLng = cam.minLongitude
    val maxLat = cam.maxLatitude
    val maxLng = cam.maxLongitude
    if (minLat != null && minLng != null && maxLat != null && maxLng != null &&
      (abs(maxLat - minLat) > 1e-6 || abs(maxLng - minLng) > 1e-6)) {
      try {
        val b = LatLngBounds.Builder()
          .include(LatLng(minLat, minLng))
          .include(LatLng(maxLat, maxLng))
          .build()
        val pad = (cam.padding * density).toInt()
        val upd = CameraUpdateFactory.newLatLngBounds(b, pad)
        m.moveCamera(upd)
        if (m.cameraPosition.zoom > cam.maxZoom) m.moveCamera(CameraUpdateFactory.zoomTo(cam.maxZoom))
      } catch (_: Throwable) {
        m.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng((minLat + maxLat) / 2.0, (minLng + maxLng) / 2.0), cam.maxZoom))
      }
      repositionAll()
      return
    }
    val target = if (minLat != null && minLng != null) LatLng(minLat, minLng) else LatLng(cam.latitude, cam.longitude)
    val upd = CameraUpdateFactory.newLatLngZoom(target, cam.zoom)
    if (cam.animated && ready) m.easeCamera(upd, 650) else m.moveCamera(upd)
    repositionAll()
  }

  private fun emitRegion() {
    val m = map ?: return
    val cp = m.cameraPosition
    val t: LatLng? = cp.target
    if (t == null) return
    onRegionDidChange(mapOf(
      "latitude" to t.latitude,
      "longitude" to t.longitude,
      "zoom" to cp.zoom,
      "gesture" to gestureMove
    ))
    gestureMove = false
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    startMap()
  }

  override fun onDetachedFromWindow() {
    stopMap()
    super.onDetachedFromWindow()
  }

  private fun startMap() {
    val mv = mapView ?: return
    if (destroyed) return
    if (!started) { mv.onStart(); started = true }
    if (!resumed && !hostPaused) { mv.onResume(); resumed = true }
  }

  private fun stopMap() {
    val mv = mapView ?: return
    if (resumed) { mv.onPause(); resumed = false }
    if (started) { mv.onStop(); started = false }
  }

  fun onHostPause() {
    hostPaused = true
    val mv = mapView ?: return
    if (resumed) { mv.onPause(); resumed = false }
  }

  fun onHostResume() {
    hostPaused = false
    val mv = mapView ?: return
    if (started && !resumed && !destroyed) { mv.onResume(); resumed = true }
  }

  fun destroy() {
    if (destroyed) return
    destroyed = true
    cancelSnapshot()
    for (h in holders.values) {
      h.anim?.cancel()
      h.pulse?.cancel()
    }
    holders.clear()
    markersLayer.removeAllViews()
    stopMap()
    val mv = mapView
    mapView = null
    map = null
    if (mv != null) {
      try { mv.onDestroy() } catch (_: Throwable) {}
      root.removeView(mv)
    }
    val it = live.iterator()
    while (it.hasNext()) {
      val v = it.next().get()
      if (v == null || v === this) it.remove()
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (destroyed) return
    main.post {
      if (destroyed) return@post
      if (lite) ensureSnapshot()
      val m = map
      if (m != null && cameraDirty) applyCamera(m)
      repositionAll()
    }
  }

  // ── lite (snapshot) ─────────────────────────────────────────────────────

  private fun ensureSnapshot() {
    val cam = camera ?: return
    val w = width
    val h = height
    if (w <= 0 || h <= 0) return
    liteLat = cam.latitude
    liteLng = cam.longitude
    liteZoom = cam.zoom
    val key = String.format(java.util.Locale.US, "%s|%.5f|%.5f|%.1f|%dx%d", styleUrl, cam.latitude, cam.longitude, cam.zoom, w, h)
    if (key == snapshotKey) return
    cancelSnapshot()
    snapshotKey = key
    val cached = snapCache.get(key)
    if (cached != null) { showSnapshot(cached); return }
    snapshotView.setImageBitmap(null)
    snapQueue.add(SnapJob(WeakReference(this), key))
    pumpSnapshots()
  }

  internal fun startSnapshot(key: String) {
    val w = width
    val h = height
    if (w <= 0 || h <= 0) return
    try {
      MapLibre.getInstance(context.applicationContext)
    } catch (_: Throwable) {
      return
    }
    val opts = MapSnapshotter.Options((w / density).toInt().coerceAtLeast(1), (h / density).toInt().coerceAtLeast(1))
      .withStyleBuilder(Style.Builder().fromUri(styleUrl))
      .withCameraPosition(CameraPosition.Builder().target(LatLng(liteLat, liteLng)).zoom(liteZoom).build())
      .withPixelRatio(density)
      .withLogo(false)
      .withAttribution(false)
    val snap = MapSnapshotter(context.applicationContext, opts)
    snapshotter = snap
    snapRunning.add(snap)
    snap.start(
      object : MapSnapshotter.SnapshotReadyCallback {
        override fun onSnapshotReady(snapshot: MapSnapshot) {
          snapRunning.remove(snap)
          if (snapshotter === snap) snapshotter = null
          val bmp = snapshot.bitmap
          snapCache.put(key, bmp)
          if (!destroyed && snapshotKey == key) showSnapshot(bmp)
          pumpSnapshots()
        }
      },
      object : MapSnapshotter.ErrorHandler {
        override fun onError(error: String) {
          snapRunning.remove(snap)
          if (snapshotter === snap) snapshotter = null
          if (!destroyed && snapshotKey == key) {
            snapshotKey = null
            onMapError(mapOf("message" to ("snapshot: " + error)))
          }
          pumpSnapshots()
        }
      }
    )
  }

  internal fun showSnapshot(bmp: Bitmap) {
    snapshotView.setImageBitmap(bmp)
    if (!ready) {
      ready = true
      onMapReady(mapOf("lite" to true))
    }
    repositionAll()
  }

  private fun cancelSnapshot() {
    val s = snapshotter ?: return
    snapshotter = null
    try { s.cancel() } catch (_: Throwable) {}
    snapRunning.remove(s)
    pumpSnapshots()
  }

  // ── markers ─────────────────────────────────────────────────────────────

  private fun dp(v: Float): Int = (v * density + 0.5f).toInt()

  private fun signatureOf(r: ChatyyMapMarker): String =
    "${r.kind}|${r.color}|${r.label}|${r.sublabel}|${r.imageUrl}|${r.initials}|${r.stale}|${r.highlight}"

  private fun syncMarkers() {
    val seen = HashSet<String>()
    for (r in markerRecords) {
      if (r.id.isEmpty()) continue
      seen.add(r.id)
      val existing = holders[r.id]
      val sig = signatureOf(r)
      if (existing != null && existing.signature == sig) {
        existing.record = r
        moveHolder(existing, r.latitude, r.longitude)
        continue
      }
      if (existing != null) removeHolder(r.id)
      val h = createHolder(r)
      h.signature = sig
      holders[r.id] = h
      reposition(h)
    }
    val stale = holders.keys.filter { it !in seen }
    for (id in stale) removeHolder(id)
  }

  private fun removeHolder(id: String) {
    val h = holders.remove(id) ?: return
    h.anim?.cancel()
    h.pulse?.cancel()
    markersLayer.removeView(h.view)
  }

  private fun moveHolder(h: MarkerHolder, toLat: Double, toLng: Double) {
    val fromLat = h.lat
    val fromLng = h.lng
    if (fromLat == toLat && fromLng == toLng) return
    h.anim?.cancel()
    // Long jumps (> ~2km) snap; live ticks glide like the friend is walking.
    if (abs(toLat - fromLat) > 0.02 || abs(toLng - fromLng) > 0.02) {
      h.lat = toLat
      h.lng = toLng
      reposition(h)
      return
    }
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = 800
    a.interpolator = AccelerateDecelerateInterpolator()
    a.addUpdateListener { va ->
      val f = (va.animatedValue as Float).toDouble()
      h.lat = fromLat + (toLat - fromLat) * f
      h.lng = fromLng + (toLng - fromLng) * f
      reposition(h)
    }
    h.anim = a
    a.start()
  }

  private fun repositionAll() {
    for (h in holders.values) reposition(h)
  }

  private fun project(lat: Double, lng: Double): PointF? {
    if (lite) {
      val w = width
      val h = height
      if (w <= 0 || h <= 0) return null
      val world = 512.0 * 2.0.pow(liteZoom) * density
      val x = (mercX(lng) - mercX(liteLng)) * world + w / 2.0
      val y = (mercY(lat) - mercY(liteLat)) * world + h / 2.0
      return PointF(x.toFloat(), y.toFloat())
    }
    val m = map ?: return null
    var p: PointF? = null
    try { p = m.projection.toScreenLocation(LatLng(lat, lng)) } catch (_: Throwable) { p = null }
    return p
  }

  private fun reposition(h: MarkerHolder) {
    val p = project(h.lat, h.lng)
    if (p == null) {
      h.view.visibility = View.INVISIBLE
      return
    }
    h.view.visibility = View.VISIBLE
    h.view.translationX = p.x - h.anchorX
    h.view.translationY = p.y - h.anchorY
  }

  private fun createHolder(r: ChatyyMapMarker): MarkerHolder {
    val view: View
    val anchor: (View) -> PointF
    var pulseTarget: View? = null
    when (r.kind) {
      "avatar" -> {
        val built = buildAvatar(r)
        view = built.first
        val ringCenter = built.second
        anchor = { v -> PointF(v.measuredWidth / 2f, ringCenter) }
      }
      "me" -> {
        view = buildMe(r)
        anchor = { v -> PointF(v.measuredWidth / 2f, v.measuredHeight / 2f) }
      }
      "dot", "live" -> {
        val built = buildDot(r, r.kind == "live")
        view = built.first
        pulseTarget = built.second
        anchor = { v -> PointF(v.measuredWidth / 2f, v.measuredHeight / 2f) }
      }
      else -> { // pin | search
        view = buildPin(r)
        anchor = { v -> PointF(v.measuredWidth / 2f, v.measuredHeight.toFloat()) }
      }
    }
    val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    lp.gravity = Gravity.TOP or Gravity.START
    markersLayer.addView(view, lp)
    view.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
    )
    view.layout(0, 0, view.measuredWidth, view.measuredHeight)
    val h = MarkerHolder(r, view)
    val a = anchor(view)
    h.anchorX = a.x
    h.anchorY = a.y
    if (r.kind == "avatar" || r.kind == "search" || r.kind == "pin") {
      if (r.kind != "pin" || interactive) {
        view.isClickable = true
        view.setOnClickListener { onMarkerPress(mapOf("id" to h.record.id)) }
      }
    }
    val pt = pulseTarget
    if (pt != null) {
      val pa = ValueAnimator.ofFloat(0f, 1f)
      pa.duration = 1600
      pa.repeatCount = ValueAnimator.INFINITE
      pa.addUpdateListener { va ->
        val f = va.animatedValue as Float
        pt.scaleX = 1f + 1.6f * f
        pt.scaleY = 1f + 1.6f * f
        pt.alpha = 0.45f * (1f - f)
      }
      pa.start()
      h.pulse = pa
    }
    return h
  }

  private fun circle(color: Int, strokeColor: Int, strokeDp: Float): GradientDrawable {
    val d = GradientDrawable()
    d.shape = GradientDrawable.OVAL
    d.setColor(color)
    if (strokeDp > 0f) d.setStroke(dp(strokeDp), strokeColor)
    return d
  }

  private fun pill(color: Int): GradientDrawable {
    val d = GradientDrawable()
    d.cornerRadius = dp(10f).toFloat()
    d.setColor(color)
    return d
  }

  private fun label(text: String, sizeSp: Float, fg: Int, bg: Int, bold: Boolean): TextView {
    val tv = TextView(context)
    tv.text = text
    tv.textSize = sizeSp
    tv.setTextColor(fg)
    tv.maxLines = 1
    tv.setSingleLine(true)
    tv.ellipsize = android.text.TextUtils.TruncateAt.END
    tv.maxWidth = dp(150f)
    if (bold) tv.typeface = Typeface.DEFAULT_BOLD
    tv.background = pill(bg)
    tv.setPadding(dp(7f), dp(2f), dp(7f), dp(2f))
    tv.elevation = dp(2f).toFloat()
    return tv
  }

  private fun circularImage(sizeDp: Float): ImageView {
    val iv = ImageView(context)
    iv.scaleType = ImageView.ScaleType.CENTER_CROP
    iv.clipToOutline = true
    iv.outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setOval(0, 0, view.width, view.height)
      }
    }
    iv.layoutParams = FrameLayout.LayoutParams(dp(sizeDp), dp(sizeDp), Gravity.CENTER)
    return iv
  }

  // Avatar pin: ring (green online / gray stale) + photo/initials, name pill,
  // optional sublabel ("há 5min · 1,2 km"). Returns (view, ringCenterY px).
  private fun buildAvatar(r: ChatyyMapMarker): Pair<View, Float> {
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    col.gravity = Gravity.CENTER_HORIZONTAL
    val ringSize = 50f
    val ringColor = if (r.stale) Color.parseColor("#9CA3AF") else parseColor(r.color, Color.parseColor("#22C55E"))
    val ring = FrameLayout(context)
    ring.background = circle(Color.WHITE, ringColor, 3f)
    ring.elevation = dp(4f).toFloat()
    val initials = TextView(context)
    initials.text = (r.initials ?: r.label ?: "?").trim().take(1).uppercase()
    initials.setTextColor(Color.WHITE)
    initials.textSize = 17f
    initials.typeface = Typeface.DEFAULT_BOLD
    initials.gravity = Gravity.CENTER
    initials.background = circle(Color.parseColor("#4B5563"), 0, 0f)
    initials.layoutParams = FrameLayout.LayoutParams(dp(ringSize - 8f), dp(ringSize - 8f), Gravity.CENTER)
    ring.addView(initials)
    val img = circularImage(ringSize - 8f)
    img.visibility = View.GONE
    ring.addView(img)
    if (r.stale) img.alpha = 0.55f
    val url = r.imageUrl
    if (!url.isNullOrBlank()) {
      loadImage(url) { bmp ->
        if (bmp != null && !destroyed) {
          img.setImageBitmap(bmp)
          img.visibility = View.VISIBLE
          initials.visibility = View.GONE
        }
      }
    }
    col.addView(ring, LinearLayout.LayoutParams(dp(ringSize), dp(ringSize)))
    val name = r.label
    if (!name.isNullOrBlank()) {
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.topMargin = dp(3f)
      val bg = if (dark) Color.parseColor("#E61C1C21") else Color.parseColor("#F2FFFFFF")
      val fg = if (dark) Color.WHITE else Color.parseColor("#111111")
      col.addView(label(name, 11.5f, fg, bg, true), lp)
    }
    val sub = r.sublabel
    if (!sub.isNullOrBlank()) {
      val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      lp.topMargin = dp(2f)
      val bg = if (r.stale) Color.parseColor("#E6DC2626") else Color.parseColor("#B3000000")
      col.addView(label(sub, 9.5f, Color.WHITE, bg, false), lp)
    }
    if (r.highlight) { col.scaleX = 1.12f; col.scaleY = 1.12f }
    return Pair(col, dp(ringSize).toFloat() / 2f)
  }

  private fun buildMe(r: ChatyyMapMarker): View {
    val url = r.imageUrl
    val blue = parseColor(r.color, Color.parseColor("#3B82F6"))
    if (url.isNullOrBlank()) return buildDot(r, false).first
    val ring = FrameLayout(context)
    ring.background = circle(Color.WHITE, blue, 3f)
    ring.elevation = dp(4f).toFloat()
    val dot = View(context)
    dot.background = circle(blue, Color.WHITE, 0f)
    dot.layoutParams = FrameLayout.LayoutParams(dp(28f), dp(28f), Gravity.CENTER)
    ring.addView(dot)
    val img = circularImage(32f)
    img.visibility = View.GONE
    ring.addView(img)
    loadImage(url) { bmp ->
      if (bmp != null && !destroyed) {
        img.setImageBitmap(bmp)
        img.visibility = View.VISIBLE
        dot.visibility = View.GONE
      }
    }
    ring.layoutParams = FrameLayout.LayoutParams(dp(38f), dp(38f))
    val wrap = FrameLayout(context)
    wrap.addView(ring, FrameLayout.LayoutParams(dp(38f), dp(38f), Gravity.CENTER))
    return wrap
  }

  // Blue dot (+ optional pulsing halo). Returns (view, halo-to-animate?).
  private fun buildDot(r: ChatyyMapMarker, pulse: Boolean): Pair<View, View?> {
    val color = parseColor(r.color, Color.parseColor("#3B82F6"))
    val size = 56f
    val wrap = FrameLayout(context)
    var halo: View? = null
    if (pulse) {
      val hv = View(context)
      hv.background = circle(color, 0, 0f)
      hv.alpha = 0.4f
      hv.layoutParams = FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER)
      wrap.addView(hv)
      halo = hv
    }
    val dot = View(context)
    dot.background = circle(color, Color.WHITE, 3f)
    dot.elevation = dp(3f).toFloat()
    dot.layoutParams = FrameLayout.LayoutParams(dp(20f), dp(20f), Gravity.CENTER)
    wrap.addView(dot)
    wrap.layoutParams = FrameLayout.LayoutParams(dp(size), dp(size))
    wrap.minimumWidth = dp(size)
    wrap.minimumHeight = dp(size)
    wrap.clipChildren = false
    return Pair(wrap, halo)
  }

  private fun buildPin(r: ChatyyMapMarker): View {
    val defaultColor = if (r.kind == "search") "#7C3AED" else "#EF4444"
    val color = parseColor(r.color, Color.parseColor(defaultColor))
    val pin = PinView(context, color)
    val pinLp = LinearLayout.LayoutParams(dp(30f), dp(40f))
    val text = r.label
    if (text.isNullOrBlank()) {
      val wrap = LinearLayout(context)
      wrap.orientation = LinearLayout.VERTICAL
      wrap.addView(pin, pinLp)
      return wrap
    }
    val col = LinearLayout(context)
    col.orientation = LinearLayout.VERTICAL
    col.gravity = Gravity.CENTER_HORIZONTAL
    val bg = if (dark) Color.parseColor("#E61C1C21") else Color.parseColor("#F2FFFFFF")
    val fg = if (dark) Color.WHITE else Color.parseColor("#111111")
    val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    lp.bottomMargin = dp(2f)
    col.addView(label(text, 11f, fg, bg, true), lp)
    col.addView(pin, pinLp)
    return col
  }

  // Teardrop pin drawn with a Path (tip at the bottom-center = the coordinate).
  private class PinView(context: Context, private val color: Int) : View(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG)
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shadow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    init {
      fill.color = color
      fill.style = Paint.Style.FILL
      stroke.color = Color.WHITE
      stroke.style = Paint.Style.STROKE
      stroke.strokeWidth = 2.5f * resources.displayMetrics.density
      dotPaint.color = Color.WHITE
      shadow.color = Color.parseColor("#38000000")
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      val w = width.toFloat()
      val h = height.toFloat()
      val d = resources.displayMetrics.density
      val r = w / 2f - 2.5f * d
      val cx = w / 2f
      val cy = r + 2.5f * d
      val tipY = h - 1f * d
      canvas.drawOval(cx - 5f * d, tipY - 2.5f * d, cx + 5f * d, tipY + 1f * d, shadow)
      path.reset()
      // circle head + two tangents down to the tip
      val angle = Math.toRadians(35.0)
      val lx = cx - (r * cos(angle)).toFloat()
      val ly = cy + (r * sin(angle)).toFloat()
      val rx = cx + (r * cos(angle)).toFloat()
      path.moveTo(cx, tipY)
      path.lineTo(lx, ly)
      path.arcTo(cx - r, cy - r, cx + r, cy + r, 180f - 35f, 180f + 70f, false)
      path.lineTo(rx, ly)
      path.close()
      canvas.drawPath(path, fill)
      canvas.drawPath(path, stroke)
      canvas.drawCircle(cx, cy, r * 0.36f, dotPaint)
    }
  }
}
