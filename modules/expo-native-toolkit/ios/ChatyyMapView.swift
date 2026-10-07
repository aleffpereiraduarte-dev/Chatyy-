import ExpoModulesCore
import MapKit
import UIKit

// [2026-10-07 native-maps] Native map view for iOS — Apple MapKit (system
// framework, already linked by ExpoNativeChatExtras; zero binary growth, ZERO
// Google). Mirrors android/.../ChatyyMapView.kt prop/event contract 1:1:
//   props : styleUrl (ignored — MapKit tiles), dark, lite, interactive,
//           rotateEnabled, camera, markers
//   events: onMapReady, onRegionWillChange{gesture}, onRegionDidChange{latitude,
//           longitude,zoom,gesture}, onMarkerPress{id}, onMapPress{latitude,
//           longitude}, onMapError{message}
// Zoom is MapLibre/web-mercator zoom (512pt tiles) converted to/from MKMapView
// spans so JS uses the same numbers on both platforms.
//
// lite = MKMapSnapshotter image (cached) instead of a live MKMapView, for the
// chat location bubble (a list of N bubbles never creates N map views).
//
// Distinct module name ("ChatyyMapView") so JS can feature-detect the NEW view
// without probing: older binaries only ship the legacy ExpoNativeMapView.

struct ChatyyMapCameraRecord: Record {
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
  @Field var zoom: Double = 15
  @Field var animated: Bool = false
  @Field var seq: Double = 0
  @Field var minLatitude: Double? = nil
  @Field var minLongitude: Double? = nil
  @Field var maxLatitude: Double? = nil
  @Field var maxLongitude: Double? = nil
  @Field var padding: Double = 60
  @Field var maxZoom: Double = 16
}

struct ChatyyMapMarkerRecord: Record {
  @Field var id: String = ""
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
  @Field var kind: String = "pin"
  @Field var color: String? = nil
  @Field var label: String? = nil
  @Field var sublabel: String? = nil
  @Field var imageUrl: String? = nil
  @Field var initials: String? = nil
  @Field var stale: Bool = false
  @Field var highlight: Bool = false
}

public class ChatyyMapViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyMapView")

    View(ChatyyMapView.self) {
      Events("onMapReady", "onRegionWillChange", "onRegionDidChange", "onMarkerPress", "onMapPress", "onMapError")

      Prop("styleUrl") { (view: ChatyyMapView, value: String?) in view.styleUrl = value }
      Prop("dark") { (view: ChatyyMapView, value: Bool?) in view.setDark(value ?? false) }
      Prop("lite") { (view: ChatyyMapView, value: Bool?) in view.lite = value ?? false }
      Prop("interactive") { (view: ChatyyMapView, value: Bool?) in view.setInteractive(value ?? true) }
      Prop("rotateEnabled") { (view: ChatyyMapView, value: Bool?) in view.setRotateEnabled(value ?? false) }
      Prop("camera") { (view: ChatyyMapView, value: ChatyyMapCameraRecord?) in view.setCamera(value) }
      Prop("markers") { (view: ChatyyMapView, value: [ChatyyMapMarkerRecord]?) in view.setMarkers(value ?? []) }

      OnViewDidUpdateProps { (view: ChatyyMapView) in view.commit() }
    }
  }
}

// MARK: - Image cache (avatars + lite snapshots)

private final class ChatyyMapImages {
  static let shared = ChatyyMapImages()
  let avatars = NSCache<NSString, UIImage>()
  let snapshots = NSCache<NSString, UIImage>()
  private var waiters: [String: [(UIImage?) -> Void]] = [:]

  init() {
    avatars.countLimit = 200
    snapshots.countLimit = 60
  }

  func load(_ urlString: String, _ cb: @escaping (UIImage?) -> Void) {
    if let img = avatars.object(forKey: urlString as NSString) { cb(img); return }
    if waiters[urlString] != nil { waiters[urlString]?.append(cb); return }
    waiters[urlString] = [cb]
    guard let url = URL(string: urlString) else { finish(urlString, nil); return }
    var req = URLRequest(url: url)
    req.timeoutInterval = 10
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      var img: UIImage? = nil
      if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode), let data = data {
        img = UIImage(data: data)
      }
      DispatchQueue.main.async { self?.finish(urlString, img) }
    }.resume()
  }

  private func finish(_ key: String, _ img: UIImage?) {
    if let img = img { avatars.setObject(img, forKey: key as NSString) }
    let cbs = waiters.removeValue(forKey: key) ?? []
    for cb in cbs { cb(img) }
  }
}

private func chatyyColor(_ hex: String?, _ fallback: UIColor) -> UIColor {
  guard var s = hex?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return fallback }
  if s.hasPrefix("#") { s.removeFirst() }
  var v: UInt64 = 0
  guard Scanner(string: s).scanHexInt64(&v) else { return fallback }
  if s.count == 6 {
    return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
  }
  if s.count == 8 { // AARRGGBB (Android style) or RRGGBBAA? we use #AARRGGBB like Android
    return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: CGFloat((v >> 24) & 0xFF) / 255)
  }
  return fallback
}

// MARK: - Annotation

final class ChatyyMapAnnotation: NSObject, MKAnnotation {
  @objc dynamic var coordinate: CLLocationCoordinate2D
  var record: ChatyyMapMarkerRecord
  var signature: String

  init(_ r: ChatyyMapMarkerRecord, signature: String) {
    self.record = r
    self.signature = signature
    self.coordinate = CLLocationCoordinate2D(latitude: r.latitude, longitude: r.longitude)
    super.init()
  }
}

// Builds the marker visual (shared by live annotations and lite overlays).
// Returns the view and the anchor point (in the view's coordinates) that must
// sit exactly on the coordinate.
private enum ChatyyMarkerFactory {
  static func make(_ r: ChatyyMapMarkerRecord, dark: Bool) -> (UIView, CGPoint) {
    switch r.kind {
    case "avatar": return avatar(r, dark: dark)
    case "me": return me(r)
    case "dot": return dot(r, pulse: false)
    case "live": return dot(r, pulse: true)
    default: return pin(r, dark: dark)
    }
  }

  static func labelView(_ text: String, size: CGFloat, fg: UIColor, bg: UIColor, bold: Bool) -> UIView {
    let l = UILabel()
    l.text = text
    l.font = bold ? .systemFont(ofSize: size, weight: .bold) : .systemFont(ofSize: size, weight: .medium)
    l.textColor = fg
    l.lineBreakMode = .byTruncatingTail
    let maxW: CGFloat = 150
    let fit = l.sizeThatFits(CGSize(width: maxW, height: 40))
    let w = min(maxW, ceil(fit.width))
    let h = ceil(fit.height)
    let pad = UIView(frame: CGRect(x: 0, y: 0, width: w + 14, height: h + 4))
    pad.backgroundColor = bg
    pad.layer.cornerRadius = (h + 4) / 2
    pad.layer.shadowColor = UIColor.black.cgColor
    pad.layer.shadowOpacity = 0.18
    pad.layer.shadowRadius = 2
    pad.layer.shadowOffset = CGSize(width: 0, height: 1)
    l.frame = CGRect(x: 7, y: 2, width: w, height: h)
    pad.addSubview(l)
    return pad
  }

  static func avatar(_ r: ChatyyMapMarkerRecord, dark: Bool) -> (UIView, CGPoint) {
    let ring: CGFloat = 50
    var parts: [UIView] = []
    let ringColor = r.stale ? UIColor(red: 0.61, green: 0.64, blue: 0.69, alpha: 1) : chatyyColor(r.color, UIColor(red: 0.13, green: 0.77, blue: 0.37, alpha: 1))
    let circle = UIView(frame: CGRect(x: 0, y: 0, width: ring, height: ring))
    circle.backgroundColor = .white
    circle.layer.cornerRadius = ring / 2
    circle.layer.borderWidth = 3
    circle.layer.borderColor = ringColor.cgColor
    circle.layer.shadowColor = UIColor.black.cgColor
    circle.layer.shadowOpacity = 0.28
    circle.layer.shadowRadius = 4
    circle.layer.shadowOffset = CGSize(width: 0, height: 2)
    let inner = ring - 8
    let ini = UILabel(frame: CGRect(x: 4, y: 4, width: inner, height: inner))
    ini.text = String((r.initials ?? r.label ?? "?").trimmingCharacters(in: .whitespaces).prefix(1)).uppercased()
    ini.textAlignment = .center
    ini.font = .systemFont(ofSize: 18, weight: .bold)
    ini.textColor = .white
    ini.backgroundColor = UIColor(red: 0.29, green: 0.33, blue: 0.39, alpha: 1)
    ini.layer.cornerRadius = inner / 2
    ini.clipsToBounds = true
    circle.addSubview(ini)
    let iv = UIImageView(frame: CGRect(x: 4, y: 4, width: inner, height: inner))
    iv.contentMode = .scaleAspectFill
    iv.layer.cornerRadius = inner / 2
    iv.clipsToBounds = true
    iv.isHidden = true
    if r.stale { iv.alpha = 0.55 }
    circle.addSubview(iv)
    if let url = r.imageUrl, !url.isEmpty {
      ChatyyMapImages.shared.load(url) { img in
        guard let img = img else { return }
        iv.image = img
        iv.isHidden = false
        ini.isHidden = true
      }
    }
    parts.append(circle)
    let fg: UIColor = dark ? .white : UIColor(white: 0.07, alpha: 1)
    let bg: UIColor = dark ? UIColor(red: 0.11, green: 0.11, blue: 0.13, alpha: 0.9) : UIColor(white: 1, alpha: 0.95)
    if let name = r.label, !name.isEmpty {
      parts.append(labelView(name, size: 11.5, fg: fg, bg: bg, bold: true))
    }
    if let sub = r.sublabel, !sub.isEmpty {
      let sbg = r.stale ? UIColor(red: 0.86, green: 0.15, blue: 0.15, alpha: 0.9) : UIColor(white: 0, alpha: 0.7)
      parts.append(labelView(sub, size: 9.5, fg: .white, bg: sbg, bold: false))
    }
    let width = parts.map { $0.frame.width }.max() ?? ring
    var y: CGFloat = 0
    let container = UIView()
    for (i, p) in parts.enumerated() {
      if i > 0 { y += 3 }
      p.frame.origin = CGPoint(x: (width - p.frame.width) / 2, y: y)
      container.addSubview(p)
      y += p.frame.height
    }
    container.frame = CGRect(x: 0, y: 0, width: width, height: y)
    if r.highlight { container.transform = CGAffineTransform(scaleX: 1.12, y: 1.12) }
    return (container, CGPoint(x: width / 2, y: ring / 2))
  }

  static func me(_ r: ChatyyMapMarkerRecord) -> (UIView, CGPoint) {
    guard let url = r.imageUrl, !url.isEmpty else { return dot(r, pulse: false) }
    let blue = chatyyColor(r.color, UIColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1))
    let s: CGFloat = 38
    let circle = UIView(frame: CGRect(x: 0, y: 0, width: s, height: s))
    circle.backgroundColor = blue
    circle.layer.cornerRadius = s / 2
    circle.layer.borderWidth = 3
    circle.layer.borderColor = UIColor.white.cgColor
    circle.layer.shadowColor = UIColor.black.cgColor
    circle.layer.shadowOpacity = 0.3
    circle.layer.shadowRadius = 4
    let iv = UIImageView(frame: CGRect(x: 3, y: 3, width: s - 6, height: s - 6))
    iv.contentMode = .scaleAspectFill
    iv.layer.cornerRadius = (s - 6) / 2
    iv.clipsToBounds = true
    circle.addSubview(iv)
    ChatyyMapImages.shared.load(url) { img in iv.image = img }
    return (circle, CGPoint(x: s / 2, y: s / 2))
  }

  static func dot(_ r: ChatyyMapMarkerRecord, pulse: Bool) -> (UIView, CGPoint) {
    let color = chatyyColor(r.color, UIColor(red: 0.23, green: 0.51, blue: 0.96, alpha: 1))
    let s: CGFloat = 56
    let wrap = UIView(frame: CGRect(x: 0, y: 0, width: s, height: s))
    wrap.isUserInteractionEnabled = false
    let d: CGFloat = 20
    if pulse {
      let halo = UIView(frame: CGRect(x: (s - d) / 2, y: (s - d) / 2, width: d, height: d))
      halo.backgroundColor = color
      halo.layer.cornerRadius = d / 2
      halo.alpha = 0.4
      wrap.addSubview(halo)
      let scale = CABasicAnimation(keyPath: "transform.scale")
      scale.fromValue = 1
      scale.toValue = 2.6
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.45
      fade.toValue = 0
      let g = CAAnimationGroup()
      g.animations = [scale, fade]
      g.duration = 1.6
      g.repeatCount = .infinity
      g.isRemovedOnCompletion = false
      halo.layer.add(g, forKey: "pulse")
    }
    let dotV = UIView(frame: CGRect(x: (s - d) / 2, y: (s - d) / 2, width: d, height: d))
    dotV.backgroundColor = color
    dotV.layer.cornerRadius = d / 2
    dotV.layer.borderWidth = 3
    dotV.layer.borderColor = UIColor.white.cgColor
    dotV.layer.shadowColor = UIColor.black.cgColor
    dotV.layer.shadowOpacity = 0.3
    dotV.layer.shadowRadius = 3
    wrap.addSubview(dotV)
    return (wrap, CGPoint(x: s / 2, y: s / 2))
  }

  static func pin(_ r: ChatyyMapMarkerRecord, dark: Bool) -> (UIView, CGPoint) {
    let defaultColor = r.kind == "search" ? UIColor(red: 0.49, green: 0.23, blue: 0.93, alpha: 1) : UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)
    let color = chatyyColor(r.color, defaultColor)
    let w: CGFloat = 30, h: CGFloat = 40
    let pinV = UIView(frame: CGRect(x: 0, y: 0, width: w, height: h))
    let radius: CGFloat = w / 2 - 2.5
    let cx = w / 2, cy = radius + 2.5, tipY = h - 1
    let path = UIBezierPath()
    let a = CGFloat(35.0 * Double.pi / 180.0)
    path.move(to: CGPoint(x: cx, y: tipY))
    path.addLine(to: CGPoint(x: cx - radius * cos(a), y: cy + radius * sin(a)))
    path.addArc(withCenter: CGPoint(x: cx, y: cy), radius: radius, startAngle: CGFloat.pi - a, endAngle: a, clockwise: true)
    path.close()
    let shape = CAShapeLayer()
    shape.path = path.cgPath
    shape.fillColor = color.cgColor
    shape.strokeColor = UIColor.white.cgColor
    shape.lineWidth = 2.5
    shape.shadowColor = UIColor.black.cgColor
    shape.shadowOpacity = 0.3
    shape.shadowRadius = 2
    shape.shadowOffset = CGSize(width: 0, height: 1)
    pinV.layer.addSublayer(shape)
    let inner = CAShapeLayer()
    inner.path = UIBezierPath(arcCenter: CGPoint(x: cx, y: cy), radius: radius * 0.36, startAngle: 0, endAngle: 2 * .pi, clockwise: true).cgPath
    inner.fillColor = UIColor.white.cgColor
    pinV.layer.addSublayer(inner)
    guard let text = r.label, !text.isEmpty else {
      return (pinV, CGPoint(x: w / 2, y: h))
    }
    let fg: UIColor = dark ? .white : UIColor(white: 0.07, alpha: 1)
    let bg: UIColor = dark ? UIColor(red: 0.11, green: 0.11, blue: 0.13, alpha: 0.9) : UIColor(white: 1, alpha: 0.95)
    let lab = labelView(text, size: 11, fg: fg, bg: bg, bold: true)
    let width = max(w, lab.frame.width)
    let container = UIView(frame: CGRect(x: 0, y: 0, width: width, height: lab.frame.height + 2 + h))
    lab.frame.origin = CGPoint(x: (width - lab.frame.width) / 2, y: 0)
    pinV.frame.origin = CGPoint(x: (width - w) / 2, y: lab.frame.height + 2)
    container.addSubview(lab)
    container.addSubview(pinV)
    return (container, CGPoint(x: width / 2, y: container.frame.height))
  }
}

final class ChatyyAnnotationView: MKAnnotationView {
  private var content: UIView?

  func configure(_ r: ChatyyMapMarkerRecord, dark: Bool) {
    content?.removeFromSuperview()
    let (v, anchor) = ChatyyMarkerFactory.make(r, dark: dark)
    v.isUserInteractionEnabled = false
    addSubview(v)
    content = v
    frame = CGRect(x: frame.origin.x, y: frame.origin.y, width: v.frame.width, height: v.frame.height)
    v.frame.origin = .zero
    // centerOffset moves the view's CENTER relative to the coordinate point.
    centerOffset = CGPoint(x: v.frame.width / 2 - anchor.x, y: v.frame.height / 2 - anchor.y)
    canShowCallout = false
    let tappable = r.kind == "avatar" || r.kind == "search" || r.kind == "pin"
    isEnabled = tappable
    displayPriority = .required
    collisionMode = .none
    zPriority = r.kind == "me" ? .min : (r.highlight ? .max : .defaultUnselected)
  }
}

// MARK: - View

public final class ChatyyMapView: ExpoView, MKMapViewDelegate, UIGestureRecognizerDelegate {
  let onMapReady = EventDispatcher()
  let onRegionWillChange = EventDispatcher()
  let onRegionDidChange = EventDispatcher()
  let onMarkerPress = EventDispatcher()
  let onMapPress = EventDispatcher()
  let onMapError = EventDispatcher()

  var styleUrl: String?
  var lite = false
  private var dark = false
  private var interactive = true
  private var rotateEnabled = false
  private var camera: ChatyyMapCameraRecord?
  private var appliedSeq: Double = .nan
  private var cameraDirty = false
  private var records: [ChatyyMapMarkerRecord] = []
  private var markersDirty = false
  private var ready = false
  private var gestureMove = false

  private var mapView: MKMapView?
  private var annotations: [String: ChatyyMapAnnotation] = [:]

  private let snapshotView = UIImageView()
  private let liteOverlay = UIView()
  private var snapshotter: MKMapSnapshotter?
  private var snapshotKey: String?
  private var liteSnapshot: MKMapSnapshotter.Snapshot?
  private var lastSize: CGSize = .zero

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    snapshotView.contentMode = .scaleAspectFill
    snapshotView.clipsToBounds = true
    snapshotView.isHidden = true
    addSubview(snapshotView)
    liteOverlay.isUserInteractionEnabled = false
    addSubview(liteOverlay)
  }

  deinit {
    snapshotter?.cancel()
    mapView?.delegate = nil
  }

  // MARK: props

  func setDark(_ v: Bool) {
    dark = v
    overrideUserInterfaceStyle = v ? .dark : .light
    mapView?.overrideUserInterfaceStyle = v ? .dark : .light
  }

  func setInteractive(_ v: Bool) {
    interactive = v
    applyGestures()
  }

  func setRotateEnabled(_ v: Bool) {
    rotateEnabled = v
    applyGestures()
  }

  func setCamera(_ c: ChatyyMapCameraRecord?) {
    camera = c
    guard let c = c else { return }
    if appliedSeq.isNaN || c.seq != appliedSeq { cameraDirty = true }
  }

  func setMarkers(_ m: [ChatyyMapMarkerRecord]) {
    records = m
    markersDirty = true
  }

  func commit() {
    if lite {
      mapView?.isHidden = true
      snapshotView.isHidden = false
      liteOverlay.isHidden = false
      ensureSnapshot()
      if markersDirty { markersDirty = false; layoutLiteMarkers() }
    } else {
      snapshotView.isHidden = true
      liteOverlay.isHidden = true
      ensureMap()
      mapView?.isHidden = false
      if cameraDirty { applyCamera() }
      if markersDirty { markersDirty = false; syncAnnotations() }
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    mapView?.frame = bounds
    snapshotView.frame = bounds
    liteOverlay.frame = bounds
    if bounds.size != lastSize {
      lastSize = bounds.size
      if lite { ensureSnapshot() } else if cameraDirty { applyCamera() }
    }
  }

  // MARK: zoom <-> span (512pt web-mercator tiles, same as MapLibre)

  private func span(for zoom: Double, latitude: Double, size: CGSize) -> MKCoordinateSpan {
    let w = Double(size.width > 0 ? size.width : UIScreen.main.bounds.width)
    let h = Double(size.height > 0 ? size.height : w)
    let lonDelta = min(360, 360.0 * w / (512.0 * pow(2.0, zoom)))
    let latDelta = min(170, lonDelta * (h / w) * cos(latitude * .pi / 180.0))
    return MKCoordinateSpan(latitudeDelta: max(latDelta, 0.00001), longitudeDelta: max(lonDelta, 0.00001))
  }

  private func zoom(for region: MKCoordinateRegion, width: CGFloat) -> Double {
    let w = Double(width > 0 ? width : UIScreen.main.bounds.width)
    let lon = max(region.span.longitudeDelta, 0.0000001)
    return log2(360.0 * w / (512.0 * lon))
  }

  // MARK: interactive

  private func ensureMap() {
    if mapView != nil { return }
    let mv = MKMapView(frame: bounds)
    mv.delegate = self
    mv.overrideUserInterfaceStyle = dark ? .dark : .light
    mv.showsCompass = rotateEnabled
    mv.isPitchEnabled = false
    mv.showsUserLocation = false
    mv.pointOfInterestFilter = .excludingAll
    mv.register(ChatyyAnnotationView.self, forAnnotationViewWithReuseIdentifier: "chatyy")
    insertSubview(mv, at: 0)
    mapView = mv
    let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
    tap.delegate = self
    mv.addGestureRecognizer(tap)
    applyGestures()
    if let c = camera, !hasBounds(c) {
      let center = CLLocationCoordinate2D(latitude: c.latitude, longitude: c.longitude)
      mv.setRegion(MKCoordinateRegion(center: center, span: span(for: c.zoom, latitude: c.latitude, size: bounds.size)), animated: false)
      appliedSeq = c.seq
      cameraDirty = bounds.size == .zero // re-fit once laid out
    }
    syncAnnotations()
  }

  private func applyGestures() {
    guard let mv = mapView else { return }
    mv.isScrollEnabled = interactive
    mv.isZoomEnabled = interactive
    mv.isRotateEnabled = interactive && rotateEnabled
    mv.showsCompass = rotateEnabled
    mv.isUserInteractionEnabled = interactive
  }

  private func hasBounds(_ c: ChatyyMapCameraRecord) -> Bool {
    return c.minLatitude != nil && c.minLongitude != nil && c.maxLatitude != nil && c.maxLongitude != nil
  }

  private func applyCamera() {
    guard let mv = mapView, let c = camera else { return }
    if bounds.width <= 0 || bounds.height <= 0 {
      // Not laid out yet: set a provisional region; layoutSubviews re-applies.
      return
    }
    cameraDirty = false
    appliedSeq = c.seq
    if let a = c.minLatitude, let b = c.minLongitude, let x = c.maxLatitude, let y = c.maxLongitude,
       abs(x - a) > 1e-6 || abs(y - b) > 1e-6 {
      let p1 = MKMapPoint(CLLocationCoordinate2D(latitude: a, longitude: b))
      let p2 = MKMapPoint(CLLocationCoordinate2D(latitude: x, longitude: y))
      let rect = MKMapRect(x: min(p1.x, p2.x), y: min(p1.y, p2.y), width: abs(p1.x - p2.x), height: abs(p1.y - p2.y))
      let pad = CGFloat(c.padding)
      let fitted = mv.mapRectThatFits(rect, edgePadding: UIEdgeInsets(top: pad, left: pad, bottom: pad, right: pad))
      var region = MKCoordinateRegion(fitted)
      if zoom(for: region, width: bounds.width) > c.maxZoom {
        region = MKCoordinateRegion(center: region.center, span: span(for: c.maxZoom, latitude: region.center.latitude, size: bounds.size))
      }
      mv.setRegion(region, animated: c.animated && ready)
      return
    }
    let lat = c.minLatitude ?? c.latitude
    let lng = c.minLongitude ?? c.longitude
    let center = CLLocationCoordinate2D(latitude: lat, longitude: lng)
    mv.setRegion(MKCoordinateRegion(center: center, span: span(for: c.zoom, latitude: lat, size: bounds.size)), animated: c.animated && ready)
  }

  private func signature(_ r: ChatyyMapMarkerRecord) -> String {
    return "\(r.kind)|\(r.color ?? "")|\(r.label ?? "")|\(r.sublabel ?? "")|\(r.imageUrl ?? "")|\(r.initials ?? "")|\(r.stale)|\(r.highlight)|\(dark)"
  }

  private func syncAnnotations() {
    guard let mv = mapView else { return }
    var seen = Set<String>()
    for r in records where !r.id.isEmpty {
      seen.insert(r.id)
      let sig = signature(r)
      let coord = CLLocationCoordinate2D(latitude: r.latitude, longitude: r.longitude)
      if let ann = annotations[r.id] {
        ann.record = r
        if ann.signature != sig {
          ann.signature = sig
          if let v = mv.view(for: ann) as? ChatyyAnnotationView { v.configure(r, dark: dark) }
        }
        let old = ann.coordinate
        if old.latitude != coord.latitude || old.longitude != coord.longitude {
          let jump = abs(old.latitude - coord.latitude) > 0.02 || abs(old.longitude - coord.longitude) > 0.02
          if jump {
            ann.coordinate = coord
          } else {
            UIView.animate(withDuration: 0.8, delay: 0, options: [.curveEaseInOut, .allowUserInteraction]) {
              ann.coordinate = coord
            }
          }
        }
      } else {
        let ann = ChatyyMapAnnotation(r, signature: sig)
        annotations[r.id] = ann
        mv.addAnnotation(ann)
      }
    }
    for (id, ann) in annotations where !seen.contains(id) {
      mv.removeAnnotation(ann)
      annotations.removeValue(forKey: id)
    }
  }

  public func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
    guard let ann = annotation as? ChatyyMapAnnotation else { return nil }
    let v = (mapView.dequeueReusableAnnotationView(withIdentifier: "chatyy", for: ann) as? ChatyyAnnotationView)
      ?? ChatyyAnnotationView(annotation: ann, reuseIdentifier: "chatyy")
    v.annotation = ann
    v.configure(ann.record, dark: dark)
    return v
  }

  public func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
    if let ann = view.annotation as? ChatyyMapAnnotation {
      onMarkerPress(["id": ann.record.id])
      mapView.deselectAnnotation(ann, animated: false)
    }
  }

  public func mapView(_ mapView: MKMapView, regionWillChangeAnimated animated: Bool) {
    gestureMove = isUserGesture(mapView)
    onRegionWillChange(["gesture": gestureMove])
  }

  public func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
    let r = mapView.region
    onRegionDidChange([
      "latitude": r.center.latitude,
      "longitude": r.center.longitude,
      "zoom": zoom(for: r, width: mapView.bounds.width),
      "gesture": gestureMove,
    ])
    gestureMove = false
  }

  public func mapViewDidFinishRenderingMap(_ mapView: MKMapView, fullyRendered: Bool) {
    if !ready {
      ready = true
      onMapReady(["lite": false])
    }
  }

  public func mapViewDidFailLoadingMap(_ mapView: MKMapView, withError error: Error) {
    onMapError(["message": error.localizedDescription])
  }

  private func isUserGesture(_ mv: MKMapView) -> Bool {
    guard let first = mv.subviews.first, let grs = first.gestureRecognizers else { return false }
    for g in grs where g.state == .began || g.state == .changed || g.state == .ended {
      return true
    }
    return false
  }

  @objc private func handleTap(_ g: UITapGestureRecognizer) {
    guard let mv = mapView, g.state == .ended else { return }
    let p = g.location(in: mv)
    // Ignore taps that land on a marker (handled by didSelect).
    if let hit = mv.hitTest(p, with: nil), hit is MKAnnotationView || hit.superview is MKAnnotationView { return }
    let c = mv.convert(p, toCoordinateFrom: mv)
    onMapPress(["latitude": c.latitude, "longitude": c.longitude])
  }

  public func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    return true
  }

  // MARK: lite (snapshot)

  private func ensureSnapshot() {
    guard let c = camera, bounds.width > 0, bounds.height > 0 else { return }
    let key = String(format: "%.5f|%.5f|%.1f|%.0fx%.0f|%@", c.latitude, c.longitude, c.zoom, bounds.width, bounds.height, dark ? "d" : "l")
    if key == snapshotKey { return }
    snapshotKey = key
    snapshotter?.cancel()
    snapshotter = nil
    if let img = ChatyyMapImages.shared.snapshots.object(forKey: key as NSString) {
      snapshotView.image = img
      liteSnapshot = nil
      liteReady()
      return
    }
    snapshotView.image = nil
    let opts = MKMapSnapshotter.Options()
    let center = CLLocationCoordinate2D(latitude: c.latitude, longitude: c.longitude)
    opts.region = MKCoordinateRegion(center: center, span: span(for: c.zoom, latitude: c.latitude, size: bounds.size))
    opts.size = bounds.size
    opts.scale = UIScreen.main.scale
    opts.pointOfInterestFilter = .excludingAll
    opts.traitCollection = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
    let snap = MKMapSnapshotter(options: opts)
    snapshotter = snap
    snap.start(with: DispatchQueue.main) { [weak self] result, error in
      guard let self = self, self.snapshotKey == key else { return }
      self.snapshotter = nil
      if let s = result {
        ChatyyMapImages.shared.snapshots.setObject(s.image, forKey: key as NSString)
        self.snapshotView.image = s.image
        self.liteSnapshot = s
        self.liteReady()
      } else {
        self.snapshotKey = nil
        self.onMapError(["message": "snapshot: " + (error?.localizedDescription ?? "failed")])
      }
    }
  }

  private func liteReady() {
    layoutLiteMarkers()
    if !ready {
      ready = true
      onMapReady(["lite": true])
    }
  }

  private func layoutLiteMarkers() {
    liteOverlay.subviews.forEach { $0.removeFromSuperview() }
    guard let c = camera, bounds.width > 0 else { return }
    for r in records where !r.id.isEmpty {
      let (v, anchor) = ChatyyMarkerFactory.make(r, dark: dark)
      let coord = CLLocationCoordinate2D(latitude: r.latitude, longitude: r.longitude)
      var pt: CGPoint
      if let s = liteSnapshot {
        pt = s.point(for: coord)
      } else {
        // Cached image (no Snapshot object): project with web-mercator around the center.
        let world = 512.0 * pow(2.0, c.zoom)
        let dx = (mercX(r.longitude) - mercX(c.longitude)) * world
        let dy = (mercY(r.latitude) - mercY(c.latitude)) * world
        pt = CGPoint(x: bounds.width / 2 + CGFloat(dx), y: bounds.height / 2 + CGFloat(dy))
      }
      v.frame.origin = CGPoint(x: pt.x - anchor.x, y: pt.y - anchor.y)
      liteOverlay.addSubview(v)
    }
  }

  private func mercX(_ lng: Double) -> Double { return (lng + 180.0) / 360.0 }
  private func mercY(_ lat: Double) -> Double {
    let l = max(-85.05112878, min(85.05112878, lat)) * .pi / 180.0
    return (1.0 - log(tan(l) + 1.0 / cos(l)) / .pi) / 2.0
  }
}
