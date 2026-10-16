import UIKit
#if canImport(Lottie)
import Lottie
#endif

// [2026-10-16 sticker-panel v2] Figurinhas Lottie (.json) no painel:
//   • EPLottieStore: JSON baixado 1× p/ disco (EPImageLoader.loadFile — mesma
//     pasta da lista/visualizador) e decodificado fora da main; NSCache de
//     LottieAnimation por URL.
//   • EPLottieView: casca leve; só toca quando play() (célula visível + aba de
//     figurinhas ativa). lottie-ios 4.6.0 = o mesmo do lottie-react-native.
//   • EPStickerPreview: prévia grande ao segurar (imagem ou Lottie).

final class EPLottieStore {
  static let shared = EPLottieStore()

  #if canImport(Lottie)
  private let memory = NSCache<NSString, LottieAnimation>()
  private var waiters: [String: [(LottieAnimation?) -> Void]] = [:] // só na main
  private let decodeQueue = DispatchQueue(label: "br.com.chatyy.emojipanel.lottie", qos: .userInitiated)

  private init() {
    memory.countLimit = 64
  }

  func cached(_ uri: String) -> LottieAnimation? {
    if uri.isEmpty { return nil }
    return memory.object(forKey: uri as NSString)
  }

  /// completion SEMPRE na main.
  func load(_ uri: String, completion: @escaping (LottieAnimation?) -> Void) {
    if uri.isEmpty { completion(nil); return }
    if let a = memory.object(forKey: uri as NSString) { completion(a); return }
    if waiters[uri] != nil { waiters[uri]?.append(completion); return }
    waiters[uri] = [completion]
    EPImageLoader.shared.loadFile(uri) { [weak self] fileURL in
      guard let self = self else { return }
      guard let fileURL = fileURL else { self.finish(uri, nil); return }
      self.decodeQueue.async {
        var anim: LottieAnimation? = nil
        if let data = try? Data(contentsOf: fileURL) {
          anim = try? JSONDecoder().decode(LottieAnimation.self, from: data)
        }
        DispatchQueue.main.async {
          if let a = anim { self.memory.setObject(a, forKey: uri as NSString) }
          self.finish(uri, anim)
        }
      }
    }
  }

  private func finish(_ uri: String, _ a: LottieAnimation?) {
    let cbs = waiters.removeValue(forKey: uri) ?? []
    for cb in cbs { cb(a) }
  }
  #else
  private init() {}
  #endif
}

final class EPLottieView: UIView {
  static var supported: Bool {
    #if canImport(Lottie)
    return true
    #else
    return false
    #endif
  }

  private(set) var uri: String = ""
  private var wantsPlay = false
  #if canImport(Lottie)
  private var animView: LottieAnimationView?
  #endif

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    clipsToBounds = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    #if canImport(Lottie)
    animView?.frame = bounds
    #endif
  }

  func setURI(_ u: String) {
    if u == uri { return }
    uri = u
    #if canImport(Lottie)
    animView?.stop()
    animView?.isHidden = true
    if u.isEmpty { return }
    if let a = EPLottieStore.shared.cached(u) {
      apply(a, fade: false)
      return
    }
    EPLottieStore.shared.load(u) { [weak self] a in
      guard let self = self, self.uri == u, let a = a else { return }
      self.apply(a, fade: true)
    }
    #endif
  }

  #if canImport(Lottie)
  private func apply(_ a: LottieAnimation, fade: Bool) {
    let v: LottieAnimationView
    if let cur = animView, cur.animation === a {
      v = cur
    } else {
      animView?.stop()
      animView?.removeFromSuperview()
      v = LottieAnimationView(animation: a)
      v.contentMode = .scaleAspectFit
      v.loopMode = .loop
      v.backgroundBehavior = .pauseAndRestore
      v.isUserInteractionEnabled = false
      v.frame = bounds
      addSubview(v)
      animView = v
    }
    v.isHidden = false
    if wantsPlay {
      v.play()
    } else {
      v.currentProgress = 0
    }
    if fade {
      v.alpha = 0
      UIView.animate(withDuration: 0.18) { v.alpha = 1 }
    } else {
      v.alpha = 1
    }
  }
  #endif

  func play() {
    wantsPlay = true
    #if canImport(Lottie)
    if let v = animView, !v.isHidden, !v.isAnimationPlaying { v.play() }
    #endif
  }

  func pause() {
    wantsPlay = false
    #if canImport(Lottie)
    if let v = animView, v.isAnimationPlaying { v.pause() }
    #endif
  }

  func reset() {
    pause()
    setURI("")
  }
}

/// Prévia grande de figurinha (segurar). Sem toque próprio: o gesto da grade
/// continua dono do dedo (arrastar troca a figurinha da prévia).
final class EPStickerPreview: UIView {
  private let dimView = UIView()
  private let cardView = UIView()
  private let previewImage = UIImageView()
  private let previewLottie = EPLottieView()
  private var previewURI = ""
  private var side: CGFloat = 240

  init(theme: EPTheme) {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    dimView.backgroundColor = UIColor.black.withAlphaComponent(theme.dark ? 0.55 : 0.3)
    dimView.alpha = 0
    addSubview(dimView)
    cardView.alpha = 0
    addSubview(cardView)
    previewImage.contentMode = .scaleAspectFit
    cardView.addSubview(previewImage)
    previewLottie.isHidden = true
    cardView.addSubview(previewLottie)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// anchorBottom = topo do painel na janela (a prévia fica acima dele).
  func epShow(uri: String, lottie: Bool, anchorBottom: CGFloat, topInset: CGFloat) {
    let b = bounds
    dimView.frame = b
    side = floor(min(b.width * 0.62, 280))
    let minY = topInset + side / 2 + 12
    let cy = max(minY, min(b.height / 2, anchorBottom - side / 2 - 28))
    cardView.bounds = CGRect(x: 0, y: 0, width: side, height: side)
    cardView.center = CGPoint(x: b.midX, y: cy)
    previewImage.frame = cardView.bounds
    previewLottie.frame = cardView.bounds
    epSet(uri: uri, lottie: lottie, animated: false)
    cardView.transform = CGAffineTransform(scaleX: 0.4, y: 0.4)
    UIView.animate(withDuration: 0.2) { self.dimView.alpha = 1 }
    UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.68, initialSpringVelocity: 0.5, options: [.beginFromCurrentState]) {
      self.cardView.alpha = 1
      self.cardView.transform = .identity
    }
  }

  func epSet(uri: String, lottie: Bool, animated: Bool) {
    if uri == previewURI { return }
    previewURI = uri
    if lottie && EPLottieView.supported {
      previewImage.isHidden = true
      previewImage.stopAnimating()
      previewImage.image = nil
      previewLottie.isHidden = false
      previewLottie.setURI(uri)
      previewLottie.play()
    } else {
      previewLottie.reset()
      previewLottie.isHidden = true
      previewImage.isHidden = false
      let px = side * UIScreen.main.scale
      if let img = EPImageLoader.shared.cached(uri, maxPixel: px) ?? EPImageLoader.shared.cached(uri, maxPixel: 256) {
        previewImage.image = img
        if img.images != nil { previewImage.startAnimating() }
      } else {
        previewImage.image = nil
      }
      EPImageLoader.shared.load(uri, maxPixel: px) { [weak self] img in
        guard let self = self, self.previewURI == uri, let img = img else { return }
        self.previewImage.image = img
        if img.images != nil { self.previewImage.startAnimating() }
      }
    }
    if animated {
      cardView.transform = CGAffineTransform(scaleX: 0.86, y: 0.86)
      UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0.4, options: [.beginFromCurrentState]) {
        self.cardView.transform = .identity
      }
    }
  }

  func epDismiss() {
    previewLottie.pause()
    UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState], animations: {
      self.dimView.alpha = 0
      self.cardView.alpha = 0
      self.cardView.transform = CGAffineTransform(scaleX: 0.82, y: 0.82)
    }, completion: { _ in
      self.previewLottie.reset()
      self.removeFromSuperview()
    })
  }
}
