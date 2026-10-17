import UIKit

// [2026-10-15 photos-native] Células, cabeçalho e barra de rolagem rápida da
// grade de Fotos. Ícones desenhados em código (UIBezierPath) e cacheados —
// nada de emoji/asset.

enum PGBadge: Int { case none = 0, cloud, uploading, pending, failed, local, cloudOnly }

struct PGTheme {
  var background = UIColor.systemBackground
  var text = UIColor.label
  var textSecondary = UIColor.secondaryLabel
  var accent = UIColor.systemBlue
  var header = UIColor.systemBackground
  var check = UIColor.systemBlue

  /// [2026-10-15 photos-flicker] tema igual → setTheme não recarrega a grade.
  func same(_ o: PGTheme) -> Bool {
    return background.isEqual(o.background) && text.isEqual(o.text) && textSecondary.isEqual(o.textSecondary)
      && accent.isEqual(o.accent) && header.isEqual(o.header) && check.isEqual(o.check)
  }

  static func color(_ v: Any?) -> UIColor? {
    guard var s = v as? String else { return nil }
    s = s.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard let n = UInt64(s, radix: 16) else { return nil }
    switch s.count {
    case 6:
      return UIColor(red: CGFloat((n >> 16) & 0xff) / 255, green: CGFloat((n >> 8) & 0xff) / 255, blue: CGFloat(n & 0xff) / 255, alpha: 1)
    case 8:
      return UIColor(red: CGFloat((n >> 16) & 0xff) / 255, green: CGFloat((n >> 8) & 0xff) / 255, blue: CGFloat(n & 0xff) / 255, alpha: CGFloat((n >> 24) & 0xff) / 255)
    default:
      return nil
    }
  }
}

enum PGIcons {
  private static var cache: [String: UIImage] = [:]

  /// Selo 18pt: círculo escuro translúcido + glifo branco.
  static func badge(_ b: PGBadge) -> UIImage? {
    if b == .none { return nil }
    let k = "badge\(b.rawValue)"
    if let i = cache[k] { return i }
    let size = CGSize(width: 18, height: 18)
    let img = UIGraphicsImageRenderer(size: size).image { ctx in
      let c = ctx.cgContext
      UIColor(white: 0, alpha: 0.45).setFill()
      c.fillEllipse(in: CGRect(origin: .zero, size: size))
      UIColor.white.setStroke()
      UIColor.white.setFill()
      // nuvem base (centro 9,9)
      let cloud = UIBezierPath()
      cloud.move(to: CGPoint(x: 5.2, y: 12.2))
      cloud.addCurve(to: CGPoint(x: 5.6, y: 8.4), controlPoint1: CGPoint(x: 3.6, y: 12.0), controlPoint2: CGPoint(x: 3.8, y: 8.6))
      cloud.addCurve(to: CGPoint(x: 9.4, y: 5.4), controlPoint1: CGPoint(x: 6.0, y: 6.2), controlPoint2: CGPoint(x: 7.8, y: 5.4))
      cloud.addCurve(to: CGPoint(x: 12.6, y: 8.0), controlPoint1: CGPoint(x: 11.0, y: 5.4), controlPoint2: CGPoint(x: 12.2, y: 6.4))
      cloud.addCurve(to: CGPoint(x: 13.0, y: 12.2), controlPoint1: CGPoint(x: 14.6, y: 8.2), controlPoint2: CGPoint(x: 14.8, y: 12.0))
      cloud.close()
      cloud.lineWidth = 1.2
      cloud.lineJoinStyle = .round
      switch b {
      case .cloud:
        cloud.stroke()
        let ck = UIBezierPath()
        ck.move(to: CGPoint(x: 7.2, y: 9.4)); ck.addLine(to: CGPoint(x: 8.6, y: 10.8)); ck.addLine(to: CGPoint(x: 11.0, y: 8.2))
        ck.lineWidth = 1.3; ck.lineCapStyle = .round; ck.lineJoinStyle = .round; ck.stroke()
      case .cloudOnly:
        cloud.fill()
      case .uploading:
        cloud.stroke()
        let ar = UIBezierPath()
        ar.move(to: CGPoint(x: 9.1, y: 11.6)); ar.addLine(to: CGPoint(x: 9.1, y: 7.6))
        ar.move(to: CGPoint(x: 7.5, y: 9.1)); ar.addLine(to: CGPoint(x: 9.1, y: 7.5)); ar.addLine(to: CGPoint(x: 10.7, y: 9.1))
        ar.lineWidth = 1.3; ar.lineCapStyle = .round; ar.lineJoinStyle = .round; ar.stroke()
      case .pending:
        cloud.setLineDash([1.6, 1.4], count: 2, phase: 0)
        cloud.stroke()
      case .failed:
        cloud.stroke()
        let ex = UIBezierPath()
        ex.move(to: CGPoint(x: 9.1, y: 7.4)); ex.addLine(to: CGPoint(x: 9.1, y: 9.6))
        ex.lineWidth = 1.4; ex.lineCapStyle = .round; ex.stroke()
        c.fillEllipse(in: CGRect(x: 8.4, y: 10.4, width: 1.4, height: 1.4))
      case .local:
        cloud.stroke()
        let sl = UIBezierPath()
        sl.move(to: CGPoint(x: 4.4, y: 4.6)); sl.addLine(to: CGPoint(x: 13.8, y: 13.6))
        sl.lineWidth = 1.3; sl.lineCapStyle = .round; sl.stroke()
      case .none:
        break
      }
    }
    cache[k] = img
    return img
  }

  /// Círculo de seleção 22pt (vazio ou cheio com check).
  static func check(_ on: Bool, color: UIColor) -> UIImage {
    let k = "check\(on)\(color.hashValue)"
    if let i = cache[k] { return i }
    let size = CGSize(width: 22, height: 22)
    let img = UIGraphicsImageRenderer(size: size).image { ctx in
      let r = CGRect(x: 1, y: 1, width: 20, height: 20)
      if on {
        color.setFill(); ctx.cgContext.fillEllipse(in: r)
        UIColor.white.setStroke()
        let p = UIBezierPath(ovalIn: r); p.lineWidth = 1.5; p.stroke()
        let ck = UIBezierPath()
        ck.move(to: CGPoint(x: 6.5, y: 11.2)); ck.addLine(to: CGPoint(x: 9.6, y: 14.2)); ck.addLine(to: CGPoint(x: 15.6, y: 8.0))
        ck.lineWidth = 2; ck.lineCapStyle = .round; ck.lineJoinStyle = .round; ck.stroke()
      } else {
        UIColor(white: 0, alpha: 0.18).setFill(); ctx.cgContext.fillEllipse(in: r)
        UIColor.white.setStroke()
        let p = UIBezierPath(ovalIn: r); p.lineWidth = 1.5; p.stroke()
      }
    }
    cache[k] = img
    return img
  }

  static func play() -> UIImage {
    if let i = cache["play"] { return i }
    let img = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { _ in
      UIColor.white.setFill()
      let p = UIBezierPath()
      p.move(to: CGPoint(x: 2, y: 1)); p.addLine(to: CGPoint(x: 9, y: 5)); p.addLine(to: CGPoint(x: 2, y: 9)); p.close()
      p.fill()
    }
    cache["play"] = img
    return img
  }
}

final class PGCell: UICollectionViewCell {
  static let reuseId = "PGCell"
  let imageView = UIImageView()
  private let gradient = CAGradientLayer()
  private let durationLabel = UILabel()
  private let playIcon = UIImageView()
  private let badgeView = UIImageView()
  private let checkView = UIImageView()
  private let dimView = UIView()
  var token = 0
  var requestId: Int32 = 0
  // [2026-10-15 photos-flicker] item/qualidade da imagem atual — reloadData não
  // apaga a miniatura de quem continua mostrando o MESMO item (era o "piscar").
  var itemKey = ""
  var imagePx: CGFloat = 0
  var imageFinal = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = true
    contentView.backgroundColor = UIColor(white: 0.5, alpha: 0.12)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    contentView.addSubview(imageView)
    gradient.colors = [UIColor.clear.cgColor, UIColor(white: 0, alpha: 0.38).cgColor]
    gradient.isHidden = true
    contentView.layer.addSublayer(gradient)
    durationLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
    durationLabel.textColor = .white
    contentView.addSubview(durationLabel)
    playIcon.image = PGIcons.play()
    contentView.addSubview(playIcon)
    contentView.addSubview(badgeView)
    dimView.backgroundColor = UIColor(white: 1, alpha: 0.18)
    dimView.isHidden = true
    contentView.addSubview(dimView)
    contentView.addSubview(checkView)
    isAccessibilityElement = true
    accessibilityTraits = .image
  }

  required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    // [2026-10-15 photos-flicker] NÃO zera a imagem aqui: o cellForItem decide
    // (mesmo item → mantém; outro item → cache em memória ou nil). Callbacks
    // em voo de outro item caem pelo token.
    token += 1
    contentView.transform = .identity
    checkView.transform = .identity
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    imageView.frame = b
    dimView.frame = b
    let small = b.width < 48
    CATransaction.begin(); CATransaction.setDisableActions(true)
    gradient.frame = CGRect(x: 0, y: b.height * 0.6, width: b.width, height: b.height * 0.4)
    CATransaction.commit()
    badgeView.frame = CGRect(x: b.width - 21, y: b.height - 21, width: 18, height: 18)
    // bounds+center (nunca frame): o check pode estar com transform da mola.
    checkView.bounds = CGRect(x: 0, y: 0, width: 22, height: 22)
    checkView.center = CGPoint(x: b.width - 26 + 11, y: 4 + 11)
    playIcon.frame = CGRect(x: 5, y: b.height - 15, width: 10, height: 10)
    durationLabel.frame = CGRect(x: 17, y: b.height - 18, width: b.width - 40, height: 16)
    badgeView.isHidden = small || badgeView.image == nil
  }

  func configure(video: Bool, duration: Double, badge: PGBadge, selecting: Bool, selected: Bool, compact: Bool, check: UIColor) {
    let showVideo = video && !compact
    gradient.isHidden = !showVideo
    playIcon.isHidden = !showVideo
    durationLabel.isHidden = !showVideo
    if showVideo { durationLabel.text = PGCell.fmt(duration) }
    badgeView.image = compact ? nil : PGIcons.badge(badge)
    badgeView.isHidden = compact || badgeView.image == nil
    checkView.isHidden = !selecting || compact
    checkView.image = PGIcons.check(selected, color: check)
    dimView.isHidden = !(selecting && selected)
    contentView.transform = (selecting && selected && !compact) ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
    if compact && selecting && selected {
      contentView.layer.borderWidth = 2
      contentView.layer.borderColor = check.cgColor
    } else {
      contentView.layer.borderWidth = 0
    }
  }

  func setSelectedAnimated(_ selected: Bool, compact: Bool, check: UIColor) {
    checkView.image = PGIcons.check(selected, color: check)
    dimView.isHidden = !selected
    // [2026-10-16 motion] Check com mola (estoura de 0.55 → 1); kill switch __chatyy_motion_grid.
    if MVMotion.gridSpring && !MVMotion.reduceMotion {
      if selected { checkView.transform = CGAffineTransform(scaleX: 0.55, y: 0.55) }
      UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.62, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
        self.contentView.transform = (selected && !compact) ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
        self.checkView.transform = .identity
      }
      return
    }
    UIView.animate(withDuration: 0.16, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      self.contentView.transform = (selected && !compact) ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
    }
  }

  static func fmt(_ secs: Double) -> String {
    let s = max(0, Int(secs.rounded()))
    if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60) }
    return String(format: "%d:%02d", s / 60, s % 60)
  }
}

final class PGHeader: UICollectionReusableView {
  static let reuseId = "PGHeader"
  let label = UILabel()
  let selectButton = UIButton(type: .custom)
  private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemChromeMaterial))
  var onSelectTap: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    addSubview(blur)
    label.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    label.adjustsFontForContentSizeCategory = false
    addSubview(label)
    selectButton.addTarget(self, action: #selector(tapSelect), for: .touchUpInside)
    addSubview(selectButton)
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError() }

  @objc private func tapSelect() { onSelectTap?() }

  override func layoutSubviews() {
    super.layoutSubviews()
    blur.frame = bounds
    label.frame = CGRect(x: 14, y: 0, width: bounds.width - 60, height: bounds.height)
    selectButton.frame = CGRect(x: bounds.width - 46, y: (bounds.height - 40) / 2, width: 40, height: 40)
  }

  func configure(title: String, theme: PGTheme, big: Bool, selecting: Bool, allSelected: Bool) {
    label.text = title
    label.textColor = theme.text
    label.font = UIFont.systemFont(ofSize: big ? 20 : 15, weight: big ? .bold : .semibold)
    blur.backgroundColor = theme.header.withAlphaComponent(0.72)
    selectButton.isHidden = !selecting
    selectButton.setImage(PGIcons.check(allSelected, color: theme.check), for: .normal)
    accessibilityLabel = title
  }
}

/// Alça de rolagem rápida + balão com mês/ano.
final class PGScroller: UIView {
  let handle = UIView()
  let bubble = UILabel()
  private let grip = CAShapeLayer()
  var onDrag: ((CGFloat) -> Void)?   // fração 0…1
  var onDragState: ((Bool) -> Void)?
  private(set) var dragging = false
  private var hideWork: DispatchWorkItem?

  override init(frame: CGRect) {
    super.init(frame: frame)
    handle.frame = CGRect(x: 0, y: 0, width: 40, height: 46)
    handle.layer.cornerRadius = 20
    handle.layer.maskedCorners = [.layerMinXMinYCorner, .layerMinXMaxYCorner]
    handle.layer.shadowColor = UIColor.black.cgColor
    handle.layer.shadowOpacity = 0.18
    handle.layer.shadowRadius = 4
    handle.layer.shadowOffset = CGSize(width: 0, height: 1)
    let p = UIBezierPath()
    p.move(to: CGPoint(x: 15, y: 17)); p.addLine(to: CGPoint(x: 20, y: 12)); p.addLine(to: CGPoint(x: 25, y: 17))
    p.move(to: CGPoint(x: 15, y: 29)); p.addLine(to: CGPoint(x: 20, y: 34)); p.addLine(to: CGPoint(x: 25, y: 29))
    grip.path = p.cgPath
    grip.fillColor = UIColor.clear.cgColor
    grip.lineWidth = 2
    grip.lineCap = .round
    grip.lineJoin = .round
    handle.layer.addSublayer(grip)
    addSubview(handle)
    bubble.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    bubble.textAlignment = .center
    bubble.layer.cornerRadius = 18
    bubble.layer.masksToBounds = true
    bubble.alpha = 0
    addSubview(bubble)
    alpha = 0
    let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
    handle.addGestureRecognizer(pan)
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError() }

  func apply(theme: PGTheme) {
    handle.backgroundColor = theme.header
    grip.strokeColor = theme.textSecondary.cgColor
    bubble.backgroundColor = theme.header
    bubble.textColor = theme.text
  }

  /// Só a alça recebe toque; o resto passa p/ a grade.
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    guard alpha > 0.01 else { return false }
    return handle.frame.insetBy(dx: -10, dy: -8).contains(point)
  }

  func setFraction(_ f: CGFloat) {
    let travel = bounds.height - handle.bounds.height
    handle.frame.origin = CGPoint(x: bounds.width - handle.bounds.width, y: max(0, min(travel, travel * f)))
    bubble.center.y = handle.center.y
  }

  func setBubble(_ text: String) {
    if bubble.text == text { return }
    bubble.text = text
    let w = (text as NSString).size(withAttributes: [.font: bubble.font as Any]).width + 32
    bubble.frame = CGRect(x: handle.frame.minX - w - 12, y: handle.center.y - 18, width: w, height: 36)
  }

  func show() {
    hideWork?.cancel()
    if alpha < 1 { UIView.animate(withDuration: 0.18) { self.alpha = 1 } }
  }

  func scheduleHide() {
    hideWork?.cancel()
    let w = DispatchWorkItem { [weak self] in
      guard let self = self, !self.dragging else { return }
      UIView.animate(withDuration: 0.3) { self.alpha = 0 }
    }
    hideWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: w)
  }

  @objc private func onPan(_ g: UIPanGestureRecognizer) {
    let travel = max(1, bounds.height - handle.bounds.height)
    switch g.state {
    case .began:
      dragging = true
      onDragState?(true)
      show()
      UIView.animate(withDuration: 0.15) { self.bubble.alpha = 1 }
    case .changed:
      let y = g.location(in: self).y - handle.bounds.height / 2
      let f = max(0, min(1, y / travel))
      setFraction(f)
      onDrag?(f)
    default:
      dragging = false
      onDragState?(false)
      UIView.animate(withDuration: 0.2) { self.bubble.alpha = 0 }
      scheduleHide()
    }
  }
}
