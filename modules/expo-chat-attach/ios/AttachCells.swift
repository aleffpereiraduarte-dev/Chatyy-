import UIKit
import Photos

// [2026-10-15 native-attach] Células da grade da folha de anexos.

/// Círculo de seleção numerado (anel branco vazio → círculo cheio na cor do
/// texto do tema com o número na cor inversa). 26 pt, alvo de toque da célula.
final class CASelectBadge: UIView {
  private let label = UILabel()
  private var fill: UIColor = .white
  private var ink: UIColor = .black

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    layer.borderWidth = 1.5
    layer.borderColor = UIColor.white.cgColor
    backgroundColor = UIColor(white: 0, alpha: 0.18)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 2
    layer.shadowOffset = .zero
    label.font = .systemFont(ofSize: 13, weight: .semibold)
    label.textAlignment = .center
    addSubview(label)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func setTheme(fill: UIColor, ink: UIColor) {
    self.fill = fill
    self.ink = ink
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.width / 2
    label.frame = bounds
  }

  func set(number: Int?, animated: Bool) {
    if let n = number {
      label.text = "\(n)"
      label.textColor = ink
      backgroundColor = fill
      layer.borderColor = fill.cgColor
      if animated {
        transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.8, options: [.allowUserInteraction]) {
          self.transform = .identity
        }
      }
    } else {
      label.text = nil
      backgroundColor = UIColor(white: 0, alpha: 0.18)
      layer.borderColor = UIColor.white.cgColor
      transform = .identity
    }
  }
}

final class CAAssetCell: UICollectionViewCell {
  static let reuseId = "CAAssetCell"

  let imageView = UIImageView()
  private let durLabel = UILabel()
  private let shade = CAGradientLayer()
  let badge = CASelectBadge()
  private let dim = UIView()
  var requestId: PHImageRequestID = PHInvalidImageRequestID
  var assetId: String = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = true
    contentView.backgroundColor = UIColor(white: 0.5, alpha: 0.12)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    contentView.addSubview(imageView)
    shade.colors = [UIColor.clear.cgColor, UIColor(white: 0, alpha: 0.45).cgColor]
    shade.isHidden = true
    contentView.layer.addSublayer(shade)
    durLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
    durLabel.textColor = .white
    durLabel.textAlignment = .right
    contentView.addSubview(durLabel)
    dim.backgroundColor = UIColor(white: 1, alpha: 0.0)
    dim.isUserInteractionEnabled = false
    contentView.addSubview(dim)
    contentView.addSubview(badge)
    isAccessibilityElement = true
    accessibilityTraits = [.button, .image]
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    imageView.frame = b
    dim.frame = b
    shade.frame = CGRect(x: 0, y: b.height - 28, width: b.width, height: 28)
    durLabel.frame = CGRect(x: 4, y: b.height - 20, width: b.width - 10, height: 16)
    badge.frame = CGRect(x: b.width - 30, y: 4, width: 26, height: 26)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    imageView.image = nil
    durLabel.text = nil
    shade.isHidden = true
    badge.set(number: nil, animated: false)
    imageView.transform = .identity
    dim.backgroundColor = .clear
  }

  func configure(video: Bool, duration: Double) {
    if video {
      durLabel.text = CAFormat.duration(duration)
      shade.isHidden = false
    } else {
      durLabel.text = nil
      shade.isHidden = true
    }
  }

  func setSelected(number: Int?, animated: Bool) {
    badge.set(number: number, animated: animated)
    let t: CGAffineTransform = number != nil ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
    if animated {
      UIView.animate(withDuration: 0.28, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.4, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.imageView.transform = t
      }
    } else {
      imageView.transform = t
    }
  }
}

/// 1º quadrado: preview AO VIVO da câmera (ou ícone quando sem permissão).
final class CACameraCell: UICollectionViewCell {
  static let reuseId = "CACameraCell"

  let preview = CAPreviewView(frame: .zero)
  private let icon = UIImageView()
  private(set) var live = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = true
    contentView.backgroundColor = UIColor(white: 0.08, alpha: 1)
    preview.alpha = 0
    contentView.addSubview(preview)
    icon.image = CAFormat.symbol("camera.fill", 26, .regular)
    icon.tintColor = .white
    icon.contentMode = .center
    icon.layer.shadowColor = UIColor.black.cgColor
    icon.layer.shadowOpacity = 0.35
    icon.layer.shadowRadius = 3
    icon.layer.shadowOffset = .zero
    contentView.addSubview(icon)
    isAccessibilityElement = true
    accessibilityTraits = [.button]
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    preview.frame = contentView.bounds
    icon.frame = contentView.bounds
  }

  func startLive() {
    guard CAEngine.authorized, !live else { return }
    live = true
    preview.attach()
    UIView.animate(withDuration: 0.25, delay: 0.15, options: [.allowUserInteraction]) { self.preview.alpha = 1 }
  }

  func stopLive() {
    guard live else { return }
    live = false
    preview.detach()
    preview.alpha = 0
  }
}

/// Botão redondo de ação da barra inferior (ícone + rótulo), P&B.
final class CAActionButton: UIControl {
  let key: String
  private let circle = UIView()
  private let icon = UIImageView()
  private let gif = UILabel()
  private let label = UILabel()

  init(key: String, title: String, config: AttachConfig) {
    self.key = key
    super.init(frame: .zero)
    circle.backgroundColor = config.chip
    circle.layer.borderWidth = 1 / UIScreen.main.scale
    circle.layer.borderColor = config.border.cgColor
    circle.isUserInteractionEnabled = false
    addSubview(circle)
    if let s = CAFormat.symbolName(forAction: key) {
      icon.image = CAFormat.symbol(s, 22, .regular)
      icon.tintColor = config.text
      icon.contentMode = .center
      circle.addSubview(icon)
    } else {
      gif.text = "GIF"
      gif.font = .systemFont(ofSize: 13, weight: .heavy)
      gif.textColor = config.text
      gif.textAlignment = .center
      gif.layer.borderColor = config.text.cgColor
      gif.layer.borderWidth = 1.6
      gif.layer.cornerRadius = 4
      circle.addSubview(gif)
    }
    label.text = title
    label.font = .systemFont(ofSize: 12, weight: .medium)
    label.textColor = config.textSecondary
    label.textAlignment = .center
    label.adjustsFontSizeToFitWidth = true
    label.minimumScaleFactor = 0.8
    addSubview(label)
    isAccessibilityElement = true
    accessibilityLabel = title
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var intrinsicContentSize: CGSize { return CGSize(width: 72, height: 78) }

  override func layoutSubviews() {
    super.layoutSubviews()
    let d: CGFloat = 52
    circle.frame = CGRect(x: (bounds.width - d) / 2, y: 4, width: d, height: d)
    circle.layer.cornerRadius = d / 2
    icon.frame = circle.bounds
    gif.frame = CGRect(x: (d - 34) / 2, y: (d - 20) / 2, width: 34, height: 20)
    label.frame = CGRect(x: 0, y: 4 + d + 6, width: bounds.width, height: 15)
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.circle.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.9, y: 0.9) : .identity
      }
    }
  }
}

/// Chip alternável (HD / Como arquivo).
final class CAChip: UIControl {
  private let label = UILabel()
  private let config: AttachConfig
  var on: Bool = false { didSet { refresh() } }

  init(title: String, config: AttachConfig) {
    self.config = config
    super.init(frame: .zero)
    label.text = title
    label.font = .systemFont(ofSize: 13, weight: .semibold)
    label.textAlignment = .center
    addSubview(label)
    layer.borderWidth = 1
    isAccessibilityElement = true
    accessibilityLabel = title
    refresh()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var intrinsicContentSize: CGSize {
    let s = label.intrinsicContentSize
    return CGSize(width: s.width + 26, height: 30)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds
    layer.cornerRadius = bounds.height / 2
  }

  private func refresh() {
    backgroundColor = on ? config.text : .clear
    label.textColor = on ? config.bg : config.text
    layer.borderColor = (on ? config.text : config.textSecondary.withAlphaComponent(0.45)).cgColor
    accessibilityTraits = on ? [.button, .selected] : [.button]
  }
}
