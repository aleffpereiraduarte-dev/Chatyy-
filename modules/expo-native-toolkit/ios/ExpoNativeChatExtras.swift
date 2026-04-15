import ExpoModulesCore
import UIKit
import AVFoundation
import AVKit
import Vision
import MapKit
import PencilKit
import LocalAuthentication
import CryptoKit
import CoreSpotlight
import MobileCoreServices

// MARK: ─── 1. Image zoom/pan view (UIScrollView + UIImageView) ─────────────

public class ExpoNativeImageZoomViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeImageZoomView")
        View(NativeImageZoomView.self) {
            Events("onTap", "onDismiss")
            Prop("uri") { (view: NativeImageZoomView, value: String) in view.loadUri(value) }
        }
    }
}

public final class NativeImageZoomView: ExpoView, UIScrollViewDelegate {
    private let scrollView = UIScrollView()
    private let imageView = UIImageView()
    private var currentUri: String?
    /// In-flight image download. Cancelled when the URI changes or on
    /// deinit so a stale response can't paint over the new image.
    private var loadTask: URLSessionDataTask?
    let onTap = EventDispatcher()
    let onDismiss = EventDispatcher()

    deinit {
        loadTask?.cancel()
        loadTask = nil
    }

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.minimumZoomScale = 1.0
        scrollView.maximumZoomScale = 4.0
        scrollView.delegate = self
        scrollView.bouncesZoom = true
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        addSubview(scrollView)

        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        imageView.frame = scrollView.bounds
        imageView.translatesAutoresizingMaskIntoConstraints = true
        imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // Double-tap to zoom
        let dt = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        dt.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(dt)

        // Single-tap to dismiss
        let st = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap(_:)))
        st.require(toFail: dt)
        scrollView.addGestureRecognizer(st)
    }

    /// Maximum image download size: 50MB. Prevents OOM from malicious/huge images.
    private static let maxDownloadSize = 50 * 1024 * 1024

    func loadUri(_ uri: String) {
        // Cancel any prior in-flight load — without this, switching images
        // (e.g. swiping fast through a gallery) leaves the previous request
        // running and racing against the new one.
        loadTask?.cancel()
        loadTask = nil
        currentUri = uri
        // Reset zoom state for new image
        scrollView.setZoomScale(1.0, animated: false)
        scrollView.contentOffset = .zero
        if uri.hasPrefix("file://") {
            let path = String(uri.dropFirst("file://".count))
            imageView.image = UIImage(contentsOfFile: path)
        } else if let url = URL(string: uri) {
            let expected = uri
            let task = URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
                // Enforce 50MB size limit to prevent OOM
                if let httpResponse = response as? HTTPURLResponse,
                   let lengthStr = httpResponse.value(forHTTPHeaderField: "Content-Length"),
                   let length = Int(lengthStr), length > NativeImageZoomView.maxDownloadSize {
                    return
                }
                guard let data = data,
                      data.count <= NativeImageZoomView.maxDownloadSize,
                      let img = UIImage(data: data) else { return }
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    guard self.currentUri == expected else { return }
                    self.imageView.image = img
                    self.loadTask = nil
                }
            }
            loadTask = task
            task.resume()
        }
    }

    public func viewForZooming(in scrollView: UIScrollView) -> UIView? { return imageView }

    @objc private func handleDoubleTap(_ gr: UITapGestureRecognizer) {
        if scrollView.zoomScale > 1.0 {
            scrollView.setZoomScale(1.0, animated: true)
        } else {
            let point = gr.location(in: imageView)
            let size = CGSize(width: scrollView.bounds.width / 2, height: scrollView.bounds.height / 2)
            let rect = CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                              width: size.width, height: size.height)
            scrollView.zoom(to: rect, animated: true)
        }
    }

    @objc private func handleSingleTap(_ gr: UITapGestureRecognizer) {
        onTap([:])
    }
}

// MARK: ─── 2. Native video player (AVPlayerLayer + PiP) ───────────────────

public class ExpoNativeVideoPlayerModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeVideoPlayer")
        View(NativeVideoPlayerView.self) {
            Events("onReady", "onPlay", "onPause", "onEnd", "onError")
            Prop("uri") { (view: NativeVideoPlayerView, value: String) in view.loadUri(value) }
            Prop("autoplay") { (view: NativeVideoPlayerView, value: Bool) in view.autoplay = value }
            Prop("muted") { (view: NativeVideoPlayerView, value: Bool) in view.player?.isMuted = value }
            Prop("loop") { (view: NativeVideoPlayerView, value: Bool) in view.shouldLoop = value }
            AsyncFunction("play") { (view: NativeVideoPlayerView) in view.player?.play() }
            AsyncFunction("pause") { (view: NativeVideoPlayerView) in view.player?.pause() }
            AsyncFunction("seek") { (view: NativeVideoPlayerView, sec: Double) in
                view.player?.seek(to: CMTime(seconds: sec, preferredTimescale: 600))
            }
        }
    }
}

public final class NativeVideoPlayerView: ExpoView {
    var player: AVPlayer?
    private var playerLayer: AVPlayerLayer?
    private var endObserver: NSObjectProtocol?
    var autoplay: Bool = false
    var shouldLoop: Bool = false

    let onReady = EventDispatcher()
    let onPlay = EventDispatcher()
    let onPause = EventDispatcher()
    let onEnd = EventDispatcher()
    let onError = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = .black
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        playerLayer?.frame = bounds
    }

    func loadUri(_ uri: String) {
        // Clean up previous player and observer to prevent leaks
        if let obs = endObserver { NotificationCenter.default.removeObserver(obs); endObserver = nil }
        player?.pause()

        let cleaned = uri.replacingOccurrences(of: "file://", with: "")
        let url: URL
        if uri.hasPrefix("file://") || uri.hasPrefix("/") {
            url = URL(fileURLWithPath: cleaned)
        } else if let u = URL(string: uri) {
            url = u
        } else { return }

        let item = AVPlayerItem(url: url)
        let p = AVPlayer(playerItem: item)
        self.player = p

        let layer = AVPlayerLayer(player: p)
        layer.videoGravity = .resizeAspect
        layer.frame = bounds
        if let old = playerLayer { old.removeFromSuperlayer() }
        self.layer.addSublayer(layer)
        self.playerLayer = layer

        // End-of-playback handler (store token to remove on next load/deinit)
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item, queue: .main) { [weak self] _ in
            self?.onEnd([:])
            if self?.shouldLoop == true {
                p.seek(to: .zero)
                p.play()
            }
        }

        if autoplay { p.play() }
        onReady([:])
    }

    deinit {
        if let obs = endObserver { NotificationCenter.default.removeObserver(obs) }
    }
}

// MARK: ─── 3. Markdown / NSAttributedString rendering helper ───────────────
//          (called from JS as a function — returns serialized attributed text)

extension ExpoNativeToolkitModule {
    // Will be added via the toolkit module's definition extension
}

// MARK: ─── 4. MapKit location preview view ────────────────────────────────

public class ExpoNativeMapViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeMapView")
        View(NativeMapView.self) {
            Events("onPress")
            Prop("latitude") { (view: NativeMapView, value: Double) in view.setCoordinate(lat: value, lon: view.lon) }
            Prop("longitude") { (view: NativeMapView, value: Double) in view.setCoordinate(lat: view.lat, lon: value) }
            Prop("title") { (view: NativeMapView, value: String?) in view.markerTitle = value ?? "" }
            Prop("zoom") { (view: NativeMapView, value: Double) in view.zoomLevel = value }
        }
    }
}

public final class NativeMapView: ExpoView {
    private let mapView = MKMapView()
    var lat: Double = 0
    var lon: Double = 0
    var markerTitle: String = ""
    var zoomLevel: Double = 0.005
    let onPress = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        mapView.translatesAutoresizingMaskIntoConstraints = false
        mapView.isUserInteractionEnabled = true
        addSubview(mapView)
        NSLayoutConstraint.activate([
            mapView.topAnchor.constraint(equalTo: topAnchor),
            mapView.leadingAnchor.constraint(equalTo: leadingAnchor),
            mapView.trailingAnchor.constraint(equalTo: trailingAnchor),
            mapView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        mapView.addGestureRecognizer(tap)
    }

    func setCoordinate(lat: Double, lon: Double) {
        self.lat = lat
        self.lon = lon
        guard lat != 0 || lon != 0 else { return }
        let coord = CLLocationCoordinate2D(latitude: lat, longitude: lon)
        let region = MKCoordinateRegion(center: coord,
                                        span: MKCoordinateSpan(latitudeDelta: zoomLevel, longitudeDelta: zoomLevel))
        mapView.setRegion(region, animated: false)
        // Replace existing pins
        mapView.removeAnnotations(mapView.annotations)
        let pin = MKPointAnnotation()
        pin.coordinate = coord
        pin.title = markerTitle
        mapView.addAnnotation(pin)
    }

    @objc private func handleTap() { onPress([:]) }
}

// MARK: ─── 5. PencilKit drawing view ──────────────────────────────────────

public class ExpoNativeDrawViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeDrawView")
        View(NativeDrawView.self) {
            Prop("backgroundUri") { (view: NativeDrawView, value: String?) in view.loadBackground(value) }
            AsyncFunction("exportToFile") { (view: NativeDrawView) -> String in
                return view.exportToFile()
            }
            AsyncFunction("clear") { (view: NativeDrawView) in view.canvas.drawing = PKDrawing() }
        }
    }
}

public final class NativeDrawView: ExpoView {
    let canvas = PKCanvasView()
    private let backgroundView = UIImageView()
    private let toolPicker = PKToolPicker()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = .black

        backgroundView.translatesAutoresizingMaskIntoConstraints = false
        backgroundView.contentMode = .scaleAspectFit
        addSubview(backgroundView)

        canvas.translatesAutoresizingMaskIntoConstraints = false
        canvas.drawingPolicy = .anyInput
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        addSubview(canvas)

        NSLayoutConstraint.activate([
            backgroundView.topAnchor.constraint(equalTo: topAnchor),
            backgroundView.leadingAnchor.constraint(equalTo: leadingAnchor),
            backgroundView.trailingAnchor.constraint(equalTo: trailingAnchor),
            backgroundView.bottomAnchor.constraint(equalTo: bottomAnchor),
            canvas.topAnchor.constraint(equalTo: topAnchor),
            canvas.leadingAnchor.constraint(equalTo: leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: trailingAnchor),
            canvas.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        toolPicker.setVisible(true, forFirstResponder: canvas)
        toolPicker.addObserver(canvas)
        canvas.becomeFirstResponder()
    }

    func loadBackground(_ uri: String?) {
        guard let uri = uri else { backgroundView.image = nil; return }
        let cleaned = uri.replacingOccurrences(of: "file://", with: "")
        backgroundView.image = UIImage(contentsOfFile: cleaned)
    }

    func exportToFile() -> String {
        // Render canvas + background into a single image
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let image = renderer.image { ctx in
            backgroundView.drawHierarchy(in: bounds, afterScreenUpdates: false)
            canvas.drawing.image(from: bounds, scale: UIScreen.main.scale).draw(in: bounds)
        }
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let outUrl = cachesDir.appendingPathComponent("draw_\(UUID().uuidString).png")
        guard let data = image.pngData() else { return "" }
        do { try data.write(to: outUrl) } catch { return "" }
        return "file://" + outUrl.path
    }
}

// MARK: ─── 6. Native blur view (UIVisualEffectView) ──────────────────────

public class ExpoNativeBlurViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeBlurView")
        View(NativeBlurView.self) {
            Prop("intensity") { (view: NativeBlurView, value: Double) in view.setIntensity(value) }
            Prop("style") { (view: NativeBlurView, value: String) in view.setStyle(value) }
        }
    }
}

public final class NativeBlurView: ExpoView {
    private var blur: UIVisualEffectView

    public required init(appContext: AppContext? = nil) {
        let effect = UIBlurEffect(style: .systemMaterial)
        self.blur = UIVisualEffectView(effect: effect)
        super.init(appContext: appContext)
        blur.translatesAutoresizingMaskIntoConstraints = false
        addSubview(blur)
        NSLayoutConstraint.activate([
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    func setIntensity(_ value: Double) {
        blur.alpha = CGFloat(max(0, min(1, value)))
    }

    func setStyle(_ value: String) {
        let style: UIBlurEffect.Style = {
            switch value {
            case "ultraThin": return .systemUltraThinMaterial
            case "thin": return .systemThinMaterial
            case "regular": return .systemMaterial
            case "thick": return .systemThickMaterial
            case "chrome": return .systemChromeMaterial
            case "dark": return .systemMaterialDark
            case "light": return .systemMaterialLight
            default: return .systemMaterial
            }
        }()
        blur.effect = UIBlurEffect(style: style)
    }
}
