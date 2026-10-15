import UIKit

// [2026-10-15 native-list fase 2] Pílula de data flutuante (estilo idêntico ao
// JS de chat-conversation: paddingH 14, paddingV 6, raio 14, fonte 12 peso
// 700, sombra preta 0.18 r8 y2). Controlada por CMLListView (aparece ao rolar,
// some 1,5 s depois de parar).

final class CMLStickyView: UIView {
  var bg: UIColor = UIColor(white: 1, alpha: 0.95) { didSet { backgroundColor = bg } }
  var fg: UIColor = UIColor(white: 0, alpha: 0.7)
  var shadowOn = true { didSet { applyShadow() } }
  private let label = CMLTextView()
  private(set) var intrinsic: CGSize = CGSize(width: 60, height: 28)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = bg
    layer.cornerRadius = 14
    addSubview(label)
    applyShadow()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func applyShadow() {
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = shadowOn ? 0.18 : 0
    layer.shadowRadius = 8
    layer.shadowOffset = CGSize(width: 0, height: 2)
  }

  func setText(_ t: String, scale: CGFloat) {
    let f = UIFont.systemFont(ofSize: 12 * scale, weight: .bold)
    let l = CMLLayoutBuilder.line(t, font: f, color: fg, maxWidth: 260)
    label.layout = l
    let w = ceil(l.size.width) + 28
    let h = ceil(l.size.height) + 12
    intrinsic = CGSize(width: w, height: h)
    layer.cornerRadius = min(14, h / 2)
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let l = label.layout else { return }
    label.frame = CGRect(x: 14, y: floor((bounds.height - l.size.height) / 2), width: l.size.width + 1, height: l.size.height)
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: layer.cornerRadius).cgPath
  }
}
