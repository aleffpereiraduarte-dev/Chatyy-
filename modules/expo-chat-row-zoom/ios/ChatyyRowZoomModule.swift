import ExpoModulesCore
import UIKit

// [wave8 row-zoom] "A conversa cresce a partir da linha" (iOS).
//
// Forma escolhida (menor risco com react-native-screens): NÃO mexe no
// UINavigationController/delegate do RNSScreenStack. O JS chama begin(frame)
// ANTES do push; aqui tiramos 2 snapshots (janela inteira + recorte da linha,
// ambos via snapshotView = GPU, sem bitmap) e pomos um overlay por cima da
// janela que, por enquanto, é idêntico ao que está na tela. O JS então faz o
// push da rota com animation:'none' (por baixo do overlay). Quando a casca da
// conversa pinta o 1º frame (ready()) — ou no teto de espera — o overlay anima:
//   • um "buraco" (máscara evenOdd) cresce do retângulo da linha até a tela
//     inteira, mostrando a conversa REAL (viva) por dentro;
//   • o snapshot da linha acompanha o buraco e some nos primeiros 35 %;
//   • a lista (snapshot) faz parallax −30 % e escurece.
// Mola amortecida (ζ 0.86, ~0.42 s). No fim o overlay sai e sobra a tela real.
// Qualquer falha → begin() devolve false e o JS faz o push padrão.
// O voltar fica 100 % nativo (pop do UINavigationController com o gesto
// interativo de sempre; o JS devolve a animação padrão à rota via setOptions).
public class ChatyyRowZoomModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyRowZoom")

    Events("onZoomEnd")

    Function("apiVersion") { () -> Int in
      return 1
    }

    AsyncFunction("begin") { (opts: [String: Any]) -> Bool in
      return RZOverlay.shared.begin(opts) { [weak self] ok in
        self?.sendEvent("onZoomEnd", ["ok": ok])
      }
    }.runOnQueue(.main)

    AsyncFunction("ready") { () -> Void in
      RZOverlay.shared.ready()
    }.runOnQueue(.main)

    AsyncFunction("cancel") { () -> Void in
      RZOverlay.shared.cancel()
    }.runOnQueue(.main)
  }
}

/// Alvo fraco do CADisplayLink (o link retém o alvo).
final class RZLinkProxy: NSObject {
  weak var owner: RZOverlay?
  init(_ owner: RZOverlay) { self.owner = owner }
  @objc func step(_ link: CADisplayLink) {
    if let o = owner { o.tick() } else { link.invalidate() }
  }
}

final class RZOverlay: NSObject {
  static let shared = RZOverlay()

  private var rootView: UIView?
  private var listBox: UIView?
  private var listSnap: UIView?
  private var dimView: UIView?
  private var rowSnap: UIView?
  private var holeMask: CAShapeLayer?
  private var link: CADisplayLink?
  private var waitTimer: Timer?
  private var capTimer: Timer?
  private var endCb: ((Bool) -> Void)?
  private var fromRect: CGRect = .zero
  private var cornerR: CGFloat = 10
  private var dimMax: CGFloat = 0.28
  private var startT: CFTimeInterval = 0
  private var animating = false
  private var gen = 0

  private let duration: CFTimeInterval = 0.42
  private let zeta: Double = 0.86
  private let omega: Double = 2.0 * Double.pi / 0.42

  private func num(_ v: Any?) -> CGFloat {
    if let d = v as? Double { return CGFloat(d) }
    if let n = v as? NSNumber { return CGFloat(n.doubleValue) }
    if let i = v as? Int { return CGFloat(i) }
    return CGFloat.nan
  }

  private func keyWindow() -> UIWindow? {
    var fallback: UIWindow?
    for scene in UIApplication.shared.connectedScenes {
      guard let ws = scene as? UIWindowScene else { continue }
      for w in ws.windows where w.isKeyWindow {
        if ws.activationState == .foregroundActive { return w }
        if fallback == nil { fallback = w }
      }
    }
    return fallback
  }

  func begin(_ o: [String: Any], onEnd: @escaping (Bool) -> Void) -> Bool {
    teardown(notify: false)
    if UIAccessibility.isReduceMotionEnabled { return false }
    guard let win = keyWindow() else { return false }
    let b = win.bounds
    let x = num(o["x"]), y = num(o["y"]), w = num(o["w"]), h = num(o["h"])
    guard x.isFinite, y.isFinite, w.isFinite, h.isFinite,
          b.width > 0, b.height > 0,
          w >= 40, h >= 24, h <= b.height * 0.5 else { return false }
    let r = CGRect(x: x, y: y, width: w, height: h)
    let vis = r.intersection(b)
    guard !vis.isNull, vis.height >= h * 0.5 else { return false }

    guard let full = win.snapshotView(afterScreenUpdates: false),
          let row = win.resizableSnapshotView(from: r, afterScreenUpdates: false, withCapInsets: .zero) else {
      return false
    }
    let dark = (o["dark"] as? Bool) ?? false
    let rad = num(o["radius"])
    cornerR = rad.isFinite ? max(0, min(rad, 24)) : 10
    let dm = num(o["dim"])
    dimMax = dm.isFinite ? max(0, min(dm, 0.6)) : (dark ? 0.4 : 0.28)

    let rv = UIView(frame: b)
    rv.backgroundColor = .clear
    rv.isUserInteractionEnabled = true // engole toques durante a transição
    rv.accessibilityElementsHidden = true

    let box = UIView(frame: b)
    box.backgroundColor = dark ? .black : .white
    box.clipsToBounds = true
    box.isUserInteractionEnabled = false
    full.frame = b
    box.addSubview(full)
    let dv = UIView(frame: b)
    dv.backgroundColor = .black
    dv.alpha = 0
    dv.isUserInteractionEnabled = false
    box.addSubview(dv)
    let m = CAShapeLayer()
    m.frame = box.bounds
    m.fillRule = .evenOdd
    box.layer.mask = m
    rv.addSubview(box)

    row.bounds = CGRect(origin: .zero, size: r.size)
    row.center = CGPoint(x: r.midX, y: r.midY)
    row.clipsToBounds = true
    row.isUserInteractionEnabled = false
    rv.addSubview(row)

    win.addSubview(rv)

    rootView = rv
    listBox = box
    listSnap = full
    dimView = dv
    rowSnap = row
    holeMask = m
    fromRect = r
    endCb = onEnd
    animating = false
    gen += 1
    let g = gen
    apply(0)

    let wait = num(o["maxWait"])
    let waitS = wait.isFinite ? Double(max(0.03, min(wait / 1000.0, 0.4))) : 0.22
    waitTimer = Timer.scheduledTimer(withTimeInterval: waitS, repeats: false) { [weak self] _ in
      guard let self = self, self.gen == g else { return }
      self.go()
    }
    // teto absoluto: nunca deixa o overlay preso na tela
    capTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
      guard let self = self, self.gen == g else { return }
      self.teardown(notify: true)
    }
    return true
  }

  func ready() {
    guard rootView != nil, !animating else { return }
    go()
  }

  func cancel() {
    guard let rv = rootView else { return }
    stopLink()
    waitTimer?.invalidate(); waitTimer = nil
    capTimer?.invalidate(); capTimer = nil
    let cb = endCb
    endCb = nil
    clearRefs()
    UIView.animate(withDuration: 0.14, animations: { rv.alpha = 0 }, completion: { _ in rv.removeFromSuperview() })
    cb?(false)
  }

  private func go() {
    guard rootView != nil, !animating else { return }
    animating = true
    waitTimer?.invalidate(); waitTimer = nil
    startT = CACurrentMediaTime()
    let l = CADisplayLink(target: RZLinkProxy(self), selector: #selector(RZLinkProxy.step(_:)))
    if #available(iOS 15.0, *) {
      l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
    }
    l.add(to: .main, forMode: .common)
    link = l
  }

  func tick() {
    guard rootView != nil else { stopLink(); return }
    let t = CACurrentMediaTime() - startT
    if t >= duration {
      apply(1)
      teardown(notify: true)
      return
    }
    apply(CGFloat(spring(t)))
  }

  private func spring(_ t: Double) -> Double {
    let wd = omega * sqrt(1.0 - zeta * zeta)
    let e = exp(-zeta * omega * t)
    return 1.0 - e * (cos(wd * t) + (zeta * omega / wd) * sin(wd * t))
  }

  private func lerp(_ a: CGFloat, _ b: CGFloat, _ p: CGFloat) -> CGFloat { return a + (b - a) * p }

  private func apply(_ raw: CGFloat) {
    guard let rv = rootView, let m = holeMask else { return }
    let p = max(0, min(1, raw))
    let b = rv.bounds
    let f = fromRect
    let hole = CGRect(x: lerp(f.minX, b.minX, p), y: lerp(f.minY, b.minY, p),
                      width: lerp(f.width, b.width, p), height: lerp(f.height, b.height, p))
    let rad = cornerR * (1 - p)
    let path = UIBezierPath(rect: b)
    path.append(UIBezierPath(roundedRect: hole, cornerRadius: rad))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    m.path = path.cgPath
    CATransaction.commit()
    listSnap?.transform = CGAffineTransform(translationX: -0.3 * b.width * p, y: 0)
    dimView?.alpha = dimMax * p
    if let row = rowSnap {
      let s = hole.width / max(1, f.width)
      row.transform = CGAffineTransform(scaleX: s, y: s)
      row.center = CGPoint(x: hole.midX, y: hole.minY + f.height * s / 2)
      row.alpha = max(0, 1 - p / 0.35)
    }
  }

  private func stopLink() {
    link?.invalidate()
    link = nil
  }

  private func clearRefs() {
    rootView = nil
    listBox = nil
    listSnap = nil
    dimView = nil
    rowSnap = nil
    holeMask = nil
    animating = false
  }

  private func teardown(notify: Bool) {
    stopLink()
    waitTimer?.invalidate(); waitTimer = nil
    capTimer?.invalidate(); capTimer = nil
    let rv = rootView
    let cb = endCb
    endCb = nil
    clearRefs()
    rv?.removeFromSuperview()
    if notify, rv != nil { cb?(true) }
  }
}
