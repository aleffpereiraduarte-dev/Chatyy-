import ExpoModulesCore
import UIKit

// [2026-10-19 secure-view] "Chatyy é privacidade total" — print/gravação de uma
// conversa protegida sai com o aviso "Captura de tela bloqueada" (igual ao
// WhatsApp), não com o conteúdo.
//
// Técnica (a mesma do WhatsApp / ScreenShieldKit / SnapshotSafeView): a view
// interna ("canvas") de um UITextField com isSecureTextEntry tem a layer
// marcada pelo sistema como segura — o que estiver DENTRO dela é omitido de
// print, gravação, espelhamento/AirPlay e da foto do app switcher. Na tela ao
// vivo aparece normal.
//
//   ChatyySecureView (ExpoView, componente do Fabric)
//     ├─ placeholder  (ChatyyCaptureBlockedView: ícone câmera riscada, título,
//     │                texto, marca "Chatyy" — só aparece na captura)
//     └─ container    (canvas seguro quando `enabled`; view comum quando não)
//          └─ host    (fundo opaco = coverColor) ← filhos RN montados AQUI
//
// Fabric: mountChildComponentView/unmountChildComponentView montam os filhos
// no `host` (não em self). O host fica em (0,0) com o tamanho de self, então os
// frames que o Fabric calcula (relativos a self) valem igual. O hitTest vai
// direto ao host (não depende do hitTest do canvas privado). Ligar/desligar
// move só o host entre o canvas e a view comum (mesma janela → sem
// willMove(toWindow: nil); a lista nativa, a rolagem e o teclado continuam).
//
// Achar o canvas (muda entre versões): iOS 13/14 "_UITextFieldCanvasView",
// iOS 15–18 "_UITextLayoutCanvasView"; iOS 26 pode criar a subview só depois do
// layout → layoutIfNeeded, nome contendo "Canvas", depois o delegate da 1ª
// sublayer, por fim a 1ª subview. Sem canvas → `supported = false` e a view se
// comporta como uma View comum (o JS mantém o comportamento de antes: escudo
// na gravação + aviso de print).
public final class ChatyySecureView: ExpoView {
  private let placeholder = ChatyyCaptureBlockedView()
  private let plainContainer = UIView()
  private var secureField: UITextField?
  private var secureCanvas: UIView?
  private let host = ChatyySecureHostView()
  private var wantProtected = false
  private(set) var isProtecting = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    placeholder.isUserInteractionEnabled = false
    placeholder.isHidden = true
    addSubview(placeholder)
    plainContainer.backgroundColor = .clear
    plainContainer.isUserInteractionEnabled = true
    addSubview(plainContainer)
    host.backgroundColor = .clear
    host.isUserInteractionEnabled = true
    plainContainer.addSubview(host)
  }

  // MARK: - Props

  func setProtected(_ on: Bool) {
    wantProtected = on
    applyProtection()
  }

  func setDark(_ dark: Bool) {
    placeholder.setDark(dark)
  }

  func setCoverColor(_ c: UIColor?) {
    host.backgroundColor = c ?? .clear
  }

  func setTexts(title: String?, message: String?, brand: String?) {
    placeholder.setTexts(title: title, message: message, brand: brand)
  }

  // MARK: - Proteção

  private func applyProtection() {
    if wantProtected, let canvas = ensureCanvas() {
      if canvas.superview !== self {
        insertSubview(canvas, aboveSubview: placeholder)
      }
      canvas.frame = bounds
      if host.superview !== canvas { canvas.addSubview(host) }
      host.frame = bounds
      plainContainer.isHidden = true
      placeholder.isHidden = false
      isProtecting = true
    } else {
      if plainContainer.superview !== self { insertSubview(plainContainer, aboveSubview: placeholder) }
      plainContainer.isHidden = false
      plainContainer.frame = bounds
      if host.superview !== plainContainer { plainContainer.addSubview(host) }
      host.frame = bounds
      secureCanvas?.removeFromSuperview()
      placeholder.isHidden = true
      isProtecting = false
    }
  }

  private func ensureCanvas() -> UIView? {
    if let c = secureCanvas { return c }
    guard let made = ChatyySecureCanvas.make() else { return nil }
    secureField = made.field
    secureCanvas = made.canvas
    return made.canvas
  }

  // MARK: - Layout

  public override func layoutSubviews() {
    super.layoutSubviews()
    let b = bounds
    if placeholder.frame != b { placeholder.frame = b }
    if plainContainer.frame != b { plainContainer.frame = b }
    if let c = secureCanvas, c.superview === self, c.frame != b { c.frame = b }
    if host.frame != b { host.frame = b }
  }

  // MARK: - Filhos do Fabric → host

  public override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    let i = max(0, min(index, host.subviews.count))
    host.insertSubview(childComponentView, at: i)
  }

  public override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    childComponentView.removeFromSuperview()
  }

  // MARK: - Toque

  public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard isUserInteractionEnabled, !isHidden, alpha > 0.01, self.point(inside: point, with: event) else {
      return nil
    }
    let p = convert(point, to: host)
    if let v = host.hitTest(p, with: event) { return v }
    return self
  }
}

/// Recebe os filhos RN. Área vazia não para aqui (o ChatyySecureView devolve a
/// si mesmo, que é a view de componente com tag do React).
final class ChatyySecureHostView: UIView {
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let v = super.hitTest(point, with: event)
    return v === self ? nil : v
  }
}

enum ChatyySecureCanvas {
  /// Canvas seguro do UITextField (ver cabeçalho). nil = indisponível nesta versão.
  static func make() -> (field: UITextField, canvas: UIView)? {
    let field = UITextField()
    field.isSecureTextEntry = true
    field.frame = CGRect(x: 0, y: 0, width: 10, height: 10)
    field.setNeedsLayout()
    field.layoutIfNeeded()
    guard let canvas = findCanvas(in: field) else {
      NSLog("[ChatyySecureView] canvas seguro não encontrado — fallback")
      return nil
    }
    canvas.removeFromSuperview()
    for v in canvas.subviews { v.removeFromSuperview() }
    canvas.isUserInteractionEnabled = true
    canvas.translatesAutoresizingMaskIntoConstraints = true
    canvas.backgroundColor = .clear
    canvas.clipsToBounds = false
    canvas.autoresizingMask = []
    return (field, canvas)
  }

  private static func findCanvas(in field: UITextField) -> UIView? {
    let subs = field.subviews
    if let c = subs.first(where: { NSStringFromClass(type(of: $0)).contains("CanvasView") }) { return c }
    if let c = subs.first(where: { NSStringFromClass(type(of: $0)).contains("Canvas") }) { return c }
    if let c = field.layer.sublayers?.first?.delegate as? UIView, c !== field, c.superview === field { return c }
    // Último recurso: única subview privada do campo.
    if subs.count == 1, let c = subs.first, NSStringFromClass(type(of: c)).hasPrefix("_") { return c }
    return nil
  }

  /// Resultado da sondagem (main thread, no OnCreate do módulo). nil = ainda
  /// não sondado (o JS trata como disponível; a view cai no fallback sozinha).
  static var probed: Bool?

  static func probe() {
    if probed != nil { return }
    probed = make() != nil
  }
}

/// O que sai no print/gravação: preto&branco Chatyy.
final class ChatyyCaptureBlockedView: UIView {
  private let iconView = ChatyyCameraSlashIcon()
  private let titleLabel = UILabel()
  private let messageLabel = UILabel()
  private let brandLabel = UILabel()
  private let stack = UIStackView()
  private var dark = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    titleLabel.text = "Captura de tela bloqueada"
    titleLabel.font = UIFont.systemFont(ofSize: 20, weight: .bold)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 2

    messageLabel.text = "Para proteger a privacidade de todos no Chatyy, esta captura de tela foi bloqueada."
    messageLabel.font = UIFont.systemFont(ofSize: 15, weight: .regular)
    messageLabel.textAlignment = .center
    messageLabel.numberOfLines = 0

    brandLabel.text = "Chatyy"
    brandLabel.font = UIFont.systemFont(ofSize: 22, weight: .heavy)
    brandLabel.textAlignment = .center
    brandLabel.translatesAutoresizingMaskIntoConstraints = false

    iconView.translatesAutoresizingMaskIntoConstraints = false

    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.addArrangedSubview(iconView)
    stack.setCustomSpacing(20, after: iconView)
    stack.addArrangedSubview(titleLabel)
    stack.addArrangedSubview(messageLabel)
    addSubview(stack)
    addSubview(brandLabel)

    NSLayoutConstraint.activate([
      iconView.widthAnchor.constraint(equalToConstant: 64),
      iconView.heightAnchor.constraint(equalToConstant: 64),
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -24),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 40),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -40),
      messageLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
      brandLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
      brandLabel.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -28),
    ])
    applyColors()
  }

  func setDark(_ d: Bool) {
    if d == dark { return }
    dark = d
    applyColors()
  }

  func setTexts(title: String?, message: String?, brand: String?) {
    if let t = title, !t.isEmpty { titleLabel.text = t }
    if let m = message, !m.isEmpty { messageLabel.text = m }
    if let b = brand, !b.isEmpty { brandLabel.text = b }
  }

  private func applyColors() {
    let fg: UIColor = dark ? UIColor(white: 0.96, alpha: 1) : UIColor(white: 0.07, alpha: 1)
    let sub: UIColor = dark ? UIColor(white: 1, alpha: 0.62) : UIColor(white: 0, alpha: 0.58)
    backgroundColor = dark ? .black : .white
    titleLabel.textColor = fg
    messageLabel.textColor = sub
    brandLabel.textColor = fg
    iconView.color = fg
    iconView.gapColor = backgroundColor ?? .white
  }
}

/// Câmera com um traço diagonal (proibido), desenhada com CAShapeLayer, mono.
final class ChatyyCameraSlashIcon: UIView {
  private let body = CAShapeLayer()
  private let slash = CAShapeLayer()
  private let gap = CAShapeLayer()

  var color: UIColor = .black {
    didSet { applyColor() }
  }
  /// Cor do fundo atrás do ícone (o "vão" que recorta o traço).
  var gapColor: UIColor = .white {
    didSet { applyColor() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    isUserInteractionEnabled = false
    backgroundColor = .clear
    for l in [body, gap, slash] {
      l.fillColor = UIColor.clear.cgColor
      l.lineCap = .round
      l.lineJoin = .round
      layer.addSublayer(l)
    }
    applyColor()
  }

  private func applyColor() {
    body.strokeColor = color.cgColor
    slash.strokeColor = color.cgColor
    gap.strokeColor = gapColor.cgColor
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let s = min(bounds.width, bounds.height)
    if s <= 0 { return }
    let ox = (bounds.width - s) / 2
    let oy = (bounds.height - s) / 2
    // Grade 24×24 (igual aos ícones SVG do app).
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s / 24, y: oy + y * s / 24) }
    let k = s / 24
    let line = max(1.5, 1.6 * k)

    let path = UIBezierPath()
    // Corpo: retângulo arredondado com a "corcova" do visor em cima.
    let r: CGFloat = 2.2 * k
    let left: CGFloat = 2.5, right: CGFloat = 21.5, top: CGFloat = 7, bottom: CGFloat = 19
    path.move(to: p(left + 2.2, top))
    path.addLine(to: p(8.2, top))
    path.addLine(to: p(9.6, 4.8))
    path.addLine(to: p(14.4, 4.8))
    path.addLine(to: p(15.8, top))
    path.addLine(to: p(right - 2.2, top))
    path.addArc(withCenter: p(right - 2.2, top + 2.2), radius: r, startAngle: -.pi / 2, endAngle: 0, clockwise: true)
    path.addLine(to: p(right, bottom - 2.2))
    path.addArc(withCenter: p(right - 2.2, bottom - 2.2), radius: r, startAngle: 0, endAngle: .pi / 2, clockwise: true)
    path.addLine(to: p(left + 2.2, bottom))
    path.addArc(withCenter: p(left + 2.2, bottom - 2.2), radius: r, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
    path.addLine(to: p(left, top + 2.2))
    path.addArc(withCenter: p(left + 2.2, top + 2.2), radius: r, startAngle: .pi, endAngle: 1.5 * .pi, clockwise: true)
    path.close()
    // Lente.
    path.append(UIBezierPath(arcCenter: p(12, 12.8), radius: 3.6 * k, startAngle: 0, endAngle: 2 * .pi, clockwise: true))
    body.path = path.cgPath
    body.lineWidth = line

    let sl = UIBezierPath()
    sl.move(to: p(3, 3))
    sl.addLine(to: p(21, 21))
    gap.path = sl.cgPath
    gap.lineWidth = line * 3
    slash.path = sl.cgPath
    slash.lineWidth = line
    for l in [body, gap, slash] { l.frame = bounds }
  }
}
