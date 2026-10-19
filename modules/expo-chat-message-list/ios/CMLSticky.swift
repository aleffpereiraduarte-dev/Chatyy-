import UIKit

// [2026-10-15 native-list fase 2] Pílula de data flutuante (estilo idêntico ao
// JS de chat-conversation: paddingH 14, paddingV 6, raio 14, fonte 12 peso
// 700, sombra preta 0.18 r8 y2). Controlada por CMLListView (aparece ao rolar,
// some 1,5 s depois de parar).

final class CMLStickyView: UIView {
  var bg: UIColor = UIColor(white: 1, alpha: 0.95) { didSet { applyLook() } }
  var fg: UIColor = UIColor(white: 0, alpha: 0.7)
  var shadowOn = true { didSet { applyShadow() } }
  /// [2026-10-19 tg-style, apiVersion 12] cápsula com desfoque (sem sombra), 12 pt
  var tgStyle = false { didSet { if tgStyle != oldValue { applyLook() } } }
  /// material escuro (fundo da conversa escuro)
  var darkBlur = false { didSet { if darkBlur != oldValue { applyLook() } } }
  private let label = CMLTextView()
  private let blur = UIVisualEffectView(effect: nil)
  private(set) var intrinsic: CGSize = CGSize(width: 60, height: 28)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = bg
    layer.cornerRadius = 14
    blur.isUserInteractionEnabled = false
    blur.clipsToBounds = true
    blur.isHidden = true
    addSubview(blur)
    addSubview(label)
    applyShadow()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private func applyLook() {
    if tgStyle {
      backgroundColor = .clear
      blur.effect = CMLLook.pillBlur(dark: darkBlur)
      blur.contentView.backgroundColor = bg
      blur.isHidden = false
    } else {
      backgroundColor = bg
      blur.effect = nil
      blur.contentView.backgroundColor = nil
      blur.isHidden = true
    }
    applyShadow()
  }

  private func applyShadow() {
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = (shadowOn && !tgStyle) ? 0.18 : 0
    layer.shadowRadius = 8
    layer.shadowOffset = CGSize(width: 0, height: 2)
  }

  func setText(_ t: String, scale: CGFloat) {
    // [2026-10-17 wa-pills] = pílula de data da lista: 12,5 medium, pad 12/5, raio 8
    // [2026-10-19 tg-style] = pílula da lista com tgStyle: 12 medium, pad 10/3,5, cápsula
    let f = UIFont.systemFont(ofSize: (tgStyle ? 12 : 12.5) * scale, weight: .medium)
    let l = CMLLayoutBuilder.line(t, font: f, color: fg, maxWidth: 260)
    label.layout = l
    let w = ceil(l.size.width) + (tgStyle ? 20 : 24)
    let h = tgStyle ? max(22, ceil(l.size.height) + 7) : ceil(l.size.height) + 10
    intrinsic = CGSize(width: w, height: h)
    layer.cornerRadius = tgStyle ? h / 2 : min(8, h / 2)
    if #available(iOS 13.0, *) { layer.cornerCurve = .continuous }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let l = label.layout else { return }
    label.frame = CGRect(x: floor((bounds.width - l.size.width) / 2), y: floor((bounds.height - l.size.height) / 2), width: l.size.width + 1, height: l.size.height)
    blur.frame = bounds
    blur.layer.cornerRadius = layer.cornerRadius
    layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: layer.cornerRadius).cgPath
  }
}
