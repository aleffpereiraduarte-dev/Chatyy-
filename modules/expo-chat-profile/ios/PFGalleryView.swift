import UIKit

// [2026-10-15 native-profile] Galeria das fotos de perfil em tela cheia:
// hero a partir do avatar (círculo → encaixe), páginas horizontais, barrinhas
// segmentadas no topo (Telegram), arrastar na vertical fecha (hero de volta).

final class PFGalleryView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  var onDismiss: (() -> Void)?
  var sourceFrame: (() -> CGRect)?

  private let photos: [PFImageRef]
  private let placeholder: UIImage?
  private let backdrop = UIView()
  private let pager = UIScrollView()
  private var pages: [UIImageView] = []
  private let barsHost = UIView()
  private var bars: [UIView] = []
  private let closeButton = UIButton(type: .system)
  private var index = 0
  private var dismissing = false

  init(photos: [PFImageRef], placeholder: UIImage?, labels: [String: String]) {
    self.photos = photos
    self.placeholder = placeholder
    super.init(frame: .zero)
    backgroundColor = .clear
    backdrop.backgroundColor = .black
    backdrop.alpha = 0
    addSubview(backdrop)

    pager.isPagingEnabled = true
    pager.showsHorizontalScrollIndicator = false
    pager.showsVerticalScrollIndicator = false
    pager.alwaysBounceHorizontal = photos.count > 1
    pager.contentInsetAdjustmentBehavior = .never
    pager.delegate = self
    pager.alpha = 0
    addSubview(pager)
    for (i, _) in photos.enumerated() {
      let iv = UIImageView()
      iv.contentMode = .scaleAspectFit
      iv.clipsToBounds = true
      if i == 0 { iv.image = placeholder }
      pager.addSubview(iv)
      pages.append(iv)
    }

    barsHost.isUserInteractionEnabled = false
    barsHost.isHidden = photos.count < 2
    addSubview(barsHost)
    for _ in photos {
      let b = UIView()
      b.backgroundColor = .white
      b.layer.cornerRadius = 1.25
      b.alpha = 0.35
      barsHost.addSubview(b)
      bars.append(b)
    }

    closeButton.setImage(PFIcon.image("close", size: 18, weight: .semibold), for: .normal)
    closeButton.tintColor = .white
    closeButton.accessibilityLabel = labels["close"] ?? "Fechar"
    closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
    closeButton.alpha = 0
    addSubview(closeButton)

    let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
    pan.delegate = self
    addGestureRecognizer(pan)
    let tap = UITapGestureRecognizer(target: self, action: #selector(toggleChrome))
    addGestureRecognizer(tap)
    loadPages()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    backdrop.frame = bounds
    pager.frame = bounds
    for (i, iv) in pages.enumerated() where iv.transform == .identity {
      iv.frame = CGRect(x: CGFloat(i) * bounds.width, y: 0, width: bounds.width, height: bounds.height)
    }
    pager.contentSize = CGSize(width: bounds.width * CGFloat(max(1, pages.count)), height: bounds.height)
    let top = safeAreaInsets.top
    closeButton.frame = CGRect(x: 8, y: top + 6, width: 44, height: 44)
    let n = CGFloat(bars.count)
    let gap: CGFloat = 4
    let w = bounds.width - 16 - gap * max(0, n - 1)
    let bw = n > 0 ? w / n : 0
    barsHost.frame = CGRect(x: 8, y: top + 2, width: bounds.width - 16, height: 3)
    for (i, b) in bars.enumerated() {
      b.frame = CGRect(x: CGFloat(i) * (bw + gap), y: 0, width: bw, height: 2.5)
    }
    updateBars()
  }

  private func loadPages() {
    for (i, ref) in photos.enumerated() {
      PFImageLoader.shared.load(ref.uri, headers: ref.headers, maxPixel: 2048) { [weak self] img in
        guard let self = self, let img = img, i < self.pages.count else { return }
        UIView.transition(with: self.pages[i], duration: 0.18, options: .transitionCrossDissolve) {
          self.pages[i].image = img
        }
      }
    }
  }

  private func updateBars() {
    for (i, b) in bars.enumerated() { b.alpha = i == index ? 1 : 0.35 }
  }

  /// Retângulo (coords da view) de uma imagem encaixada (aspect fit) na tela.
  private func fitRect(for img: UIImage?) -> CGRect {
    let b = bounds
    guard let img = img, img.size.width > 0, img.size.height > 0 else {
      let side = b.width
      return CGRect(x: 0, y: (b.height - side) / 2, width: side, height: side)
    }
    let s = min(b.width / img.size.width, b.height / img.size.height)
    let w = img.size.width * s, h = img.size.height * s
    return CGRect(x: (b.width - w) / 2, y: (b.height - h) / 2, width: w, height: h)
  }

  func present(from: CGRect, index start: Int) {
    layoutIfNeeded()
    index = max(0, min(photos.count - 1, start))
    pager.contentOffset = CGPoint(x: CGFloat(index) * bounds.width, y: 0)
    let hero = UIImageView(image: pages.isEmpty ? placeholder : (pages[index].image ?? placeholder))
    hero.contentMode = .scaleAspectFill
    hero.clipsToBounds = true
    hero.frame = from
    hero.layer.cornerRadius = from.width / 2
    hero.backgroundColor = UIColor(white: 0.2, alpha: 1)
    addSubview(hero)
    let target = fitRect(for: hero.image)
    UIView.animate(withDuration: 0.46, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0.3, options: [.beginFromCurrentState]) {
      hero.frame = target
      hero.layer.cornerRadius = 0
      self.backdrop.alpha = 1
      self.closeButton.alpha = 1
    } completion: { _ in
      self.pager.alpha = 1
      UIView.animate(withDuration: 0.12, animations: { hero.alpha = 0 }, completion: { _ in hero.removeFromSuperview() })
    }
  }

  private func dismiss(velocity: CGFloat) {
    guard !dismissing else { return }
    dismissing = true
    let iv = index < pages.count ? pages[index] : nil
    let img = iv?.image ?? placeholder
    var startRect = fitRect(for: img)
    if let iv = iv { startRect = startRect.applying(CGAffineTransform(translationX: iv.transform.tx, y: iv.transform.ty)) }
    let hero = UIImageView(image: img)
    hero.contentMode = .scaleAspectFill
    hero.clipsToBounds = true
    hero.frame = startRect
    addSubview(hero)
    pager.alpha = 0
    var dest = sourceFrame?() ?? .zero
    if dest.width < 2 { dest = CGRect(x: bounds.midX - 30, y: bounds.maxY, width: 60, height: 60) }
    let destLocal = convert(dest, from: nil)
    UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: max(0, min(2, abs(velocity) / 1500)), options: [.beginFromCurrentState]) {
      hero.frame = destLocal
      hero.layer.cornerRadius = destLocal.width / 2
      self.backdrop.alpha = 0
      self.closeButton.alpha = 0
      self.barsHost.alpha = 0
    } completion: { _ in
      self.removeFromSuperview()
      self.onDismiss?()
    }
  }

  @objc private func closeTapped() { dismiss(velocity: 0) }

  @objc private func toggleChrome() {
    let show = closeButton.alpha < 0.5
    UIView.animate(withDuration: 0.2) {
      self.closeButton.alpha = show ? 1 : 0
      self.barsHost.alpha = show ? 1 : 0
    }
  }

  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    guard let pan = g as? UIPanGestureRecognizer else { return true }
    let v = pan.velocity(in: self)
    return abs(v.y) > abs(v.x)
  }

  @objc private func handlePan(_ g: UIPanGestureRecognizer) {
    guard index < pages.count else { return }
    let iv = pages[index]
    let t = g.translation(in: self)
    switch g.state {
    case .changed:
      let k = max(0.8, 1 - abs(t.y) / 1400)
      iv.transform = CGAffineTransform(translationX: t.x * 0.3, y: t.y).scaledBy(x: k, y: k)
      backdrop.alpha = max(0, 1 - abs(t.y) / 420)
    case .ended, .cancelled:
      let v = g.velocity(in: self).y
      if abs(t.y) > 100 || abs(v) > 900 {
        dismiss(velocity: v)
      } else {
        UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0, options: [.beginFromCurrentState]) {
          iv.transform = .identity
          self.backdrop.alpha = 1
        }
      }
    default:
      break
    }
  }

  func scrollViewDidScroll(_ s: UIScrollView) {
    guard s.bounds.width > 0 else { return }
    let i = Int((s.contentOffset.x / s.bounds.width).rounded())
    let ni = max(0, min(photos.count - 1, i))
    if ni != index {
      index = ni
      updateBars()
    }
  }
}
