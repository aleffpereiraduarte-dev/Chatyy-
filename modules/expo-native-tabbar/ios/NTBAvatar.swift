import UIKit

// [2026-10-18 you-tab-avatar] Foto redonda na aba "Você" (Instagram/WhatsApp).
//
// NTBAvatarLoader: baixa/lê a foto FORA da main thread, com
//   - cache de memória (NSCache, imagem já decodificada e reduzida a 96 px),
//   - cache de disco HTTP próprio (URLCache 8 MB em Caches/ntb-avatar),
//   - dedupe de pedidos em voo e "back-off" de 60 s após erro (não martela).
// ntbAvatarImage: desenha o círculo de 28 pt (.alwaysOriginal); selecionado =
//   anel de 1,5 pt na cor do rótulo ativo + foto menor por dentro.

final class NTBAvatarLoader {
  static let shared = NTBAvatarLoader()

  private let memory = NSCache<NSString, UIImage>()
  private var inflight: [String: [(UIImage?) -> Void]] = [:]
  private var failedAt: [String: Date] = [:]
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "chatyy.ntb.avatar", qos: .utility)
  private lazy var session: URLSession = {
    let cfg = URLSessionConfiguration.default
    cfg.requestCachePolicy = .useProtocolCachePolicy
    cfg.urlCache = URLCache(memoryCapacity: 1 * 1024 * 1024, diskCapacity: 8 * 1024 * 1024, diskPath: "ntb-avatar")
    cfg.timeoutIntervalForRequest = 15
    cfg.httpMaximumConnectionsPerHost = 2
    return URLSession(configuration: cfg)
  }()

  private init() {
    memory.countLimit = 8
  }

  func cached(_ url: String) -> UIImage? {
    return memory.object(forKey: url as NSString)
  }

  /// `done` sempre na main thread; nil = erro (quem chama mantém o ícone).
  func load(_ url: String, headers: [String: String]?, done: @escaping (UIImage?) -> Void) {
    if let img = cached(url) { done(img); return }
    lock.lock()
    if let t = failedAt[url], Date().timeIntervalSince(t) < 60 {
      lock.unlock()
      done(nil)
      return
    }
    if inflight[url] != nil {
      inflight[url]?.append(done)
      lock.unlock()
      return
    }
    inflight[url] = [done]
    lock.unlock()

    let finish: (Data?) -> Void = { [weak self] data in
      guard let self = self else { return }
      let img = data.flatMap { NTBAvatarLoader.decode($0) }
      if let img = img {
        self.memory.setObject(img, forKey: url as NSString)
      }
      self.lock.lock()
      let cbs = self.inflight.removeValue(forKey: url) ?? []
      if img == nil { self.failedAt[url] = Date() } else { self.failedAt.removeValue(forKey: url) }
      self.lock.unlock()
      DispatchQueue.main.async { cbs.forEach { $0(img) } }
    }

    if let fileURL = NTBAvatarLoader.localFileURL(url) {
      queue.async { finish(try? Data(contentsOf: fileURL)) }
      return
    }
    guard let remote = URL(string: url), let scheme = remote.scheme?.lowercased(),
          scheme == "https" || scheme == "http" else {
      finish(nil)
      return
    }
    var req = URLRequest(url: remote)
    headers?.forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
    session.dataTask(with: req) { [weak self] data, resp, _ in
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      let ok = code >= 200 && code < 300 && (data?.isEmpty == false)
      self?.queue.async { finish(ok ? data : nil) }
    }.resume()
  }

  static func localFileURL(_ s: String) -> URL? {
    if s.hasPrefix("file://") { return URL(string: s) }
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    return nil
  }

  /// Decodifica e reduz (lado menor 96 px, recorte quadrado central) — o
  /// desenho final é de 28 pt @3x = 84 px; evita segurar a 1024 na memória.
  static func decode(_ data: Data) -> UIImage? {
    guard let src = UIImage(data: data), let cg = src.cgImage else { return nil }
    let w = CGFloat(cg.width), h = CGFloat(cg.height)
    guard w > 0, h > 0 else { return nil }
    let side = min(w, h)
    let crop = CGRect(x: ((w - side) / 2).rounded(.down), y: ((h - side) / 2).rounded(.down), width: side, height: side)
    let squared = cg.cropping(to: crop) ?? cg
    let target: CGFloat = 96
    let fmt = UIGraphicsImageRendererFormat()
    fmt.scale = 1
    fmt.opaque = false
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: target, height: target), format: fmt)
    let base = UIImage(cgImage: squared, scale: 1, orientation: src.imageOrientation)
    return renderer.image { _ in
      base.draw(in: CGRect(x: 0, y: 0, width: target, height: target))
    }
  }
}

/// Lado do ícone da aba (pt). UITabBar aceita ~25–30 pt sem cortar.
let ntbAvatarSide: CGFloat = 28

/// Círculo pronto para UITabBarItem. `ring` = cor do anel (só selecionado).
/// [2026-10-18 you-tab-nolabel] Sem rótulo (api 4) a foto cresce para 30 pt.
let ntbAvatarSideNoLabel: CGFloat = 30

func ntbAvatarImage(_ photo: UIImage, ring: UIColor?, dark: Bool, side: CGFloat = ntbAvatarSide) -> UIImage {
  let fmt = UIGraphicsImageRendererFormat.preferred()
  fmt.opaque = false
  let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: fmt)
  let img = renderer.image { ctx in
    let full = CGRect(x: 0, y: 0, width: side, height: side)
    let photoRect: CGRect
    if let ring = ring {
      let lw: CGFloat = 1.5
      let ringRect = full.insetBy(dx: lw / 2, dy: lw / 2)
      let path = UIBezierPath(ovalIn: ringRect)
      path.lineWidth = lw
      ring.setStroke()
      path.stroke()
      // anel + 1,5 pt de respiro (igual à barra JS: 26 → foto 21)
      photoRect = full.insetBy(dx: lw + 1.5, dy: lw + 1.5)
    } else {
      photoRect = full.insetBy(dx: 1, dy: 1)
    }
    ctx.cgContext.saveGState()
    UIBezierPath(ovalIn: photoRect).addClip()
    photo.draw(in: photoRect)
    ctx.cgContext.restoreGState()
    // Contorno quase invisível: foto clara no fundo claro (ou escura no escuro)
    // não "some" na barra.
    let edge = UIBezierPath(ovalIn: photoRect.insetBy(dx: 0.25, dy: 0.25))
    edge.lineWidth = 0.5
    (dark ? UIColor(white: 1, alpha: 0.14) : UIColor(white: 0, alpha: 0.10)).setStroke()
    edge.stroke()
  }
  return img.withRenderingMode(.alwaysOriginal)
}
