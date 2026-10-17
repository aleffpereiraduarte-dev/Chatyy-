import UIKit

// [2026-10-15 native-lists] Células da aba STATUS (iOS).
// Linha = cartão arredondado (16 de margem lateral, raio 14, 80 de altura),
// avatar 52 com anel segmentado (CLRingView, visto/não visto), nome 16
// semibold, hora 13 + pílula de contagem — mesmas medidas do renderStatusRow.

/// Avatar 52 + anel segmentado (caixa 62) ou miniatura do status de texto.
final class SLAvatarView: UIView {
  static let side: CGFloat = 62
  static let inner: CGFloat = 52

  private let ring = CLRingView()
  private let clip = UIView()
  private let tileView = CLTileView()
  private let thumbLabel = UILabel()
  // [2026-10-16 P&B] Melhores amigos: selinho de estrela (anel não é mais verde).
  private let cfBadge = UIView()
  private let cfStar = UIImageView(image: UIImage(systemName: "star.fill"))

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    addSubview(ring)
    clip.clipsToBounds = true
    clip.layer.cornerRadius = SLAvatarView.inner / 2
    clip.backgroundColor = UIColor(clHex: 0x333333)
    addSubview(clip)
    clip.addSubview(tileView)
    thumbLabel.numberOfLines = 3
    thumbLabel.textAlignment = .center
    thumbLabel.textColor = .white
    thumbLabel.adjustsFontSizeToFitWidth = true
    thumbLabel.minimumScaleFactor = 0.7
    thumbLabel.isHidden = true
    clip.addSubview(thumbLabel)
    cfBadge.isHidden = true
    cfBadge.layer.cornerRadius = 9
    cfBadge.layer.borderWidth = 2
    cfStar.contentMode = .scaleAspectFit
    cfBadge.addSubview(cfStar)
    addSubview(cfBadge)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var intrinsicContentSize: CGSize { CGSize(width: SLAvatarView.side, height: SLAvatarView.side) }

  func configure(_ row: SLRow, palette: SLPalette) {
    ring.hot = palette.ink // [2026-10-16 P&B] sem verde nos Melhores amigos
    ring.cold = palette.ringViewed
    let viewed = row.ring.isEmpty ? [true] : row.ring.map { $0 == "1" }
    ring.viewed = viewed
    cfBadge.isHidden = !(row.closeFriends && viewed.contains(false))
    cfBadge.backgroundColor = palette.ink
    cfBadge.layer.borderColor = palette.card.cgColor
    cfStar.tintColor = palette.card
    if !row.thumbText.isEmpty {
      tileView.isHidden = true
      tileView.reset()
      thumbLabel.isHidden = false
      thumbLabel.text = row.thumbText
      thumbLabel.font = SLColor.thumbFont(row.thumbFont, size: 8)
      clip.backgroundColor = SLColor.parse(row.thumbBg) ?? UIColor(clHex: 0x111111)
    } else {
      thumbLabel.isHidden = true
      tileView.isHidden = false
      clip.backgroundColor = UIColor(clHex: 0x333333)
      tileView.configure(row.tile)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let s = SLAvatarView.side
    let i = SLAvatarView.inner
    ring.frame = CGRect(x: 1.5, y: 1.5, width: s - 3, height: s - 3)
    let off = (s - i) / 2
    clip.frame = CGRect(x: off, y: off, width: i, height: i)
    tileView.frame = clip.bounds
    thumbLabel.frame = clip.bounds.insetBy(dx: i * 0.1, dy: i * 0.1)
    let bc = s / 2 + (s / 2 - 3) * 0.7071
    cfBadge.frame = CGRect(x: bc - 9, y: bc - 9, width: 18, height: 18)
    cfStar.frame = cfBadge.bounds.insetBy(dx: 4.5, dy: 4.5)
  }
}

/// Linha de status (cartão).
final class SLStatusCell: UICollectionViewListCell {
  static let cardHeight: CGFloat = 80

  let card = UIView()
  private let avatar = SLAvatarView()
  private let nameLabel = UILabel()
  private let timeLabel = UILabel()
  private let countPill = UILabel()
  private var palette = SLPalette(dark: false)
  private var countWidth: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundConfiguration = UIBackgroundConfiguration.clear()
    card.layer.cornerRadius = 14
    card.layer.cornerCurve = .continuous
    card.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(card)

    avatar.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(avatar)

    nameLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    nameLabel.lineBreakMode = .byTruncatingTail
    nameLabel.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(nameLabel)

    timeLabel.font = UIFont.systemFont(ofSize: 13)
    timeLabel.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(timeLabel)

    countPill.font = UIFont.systemFont(ofSize: 11, weight: .bold)
    countPill.textAlignment = .center
    countPill.layer.cornerRadius = 8
    countPill.clipsToBounds = true
    countPill.translatesAutoresizingMaskIntoConstraints = false
    card.addSubview(countPill)

    let bottom = contentView.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: 6)
    bottom.priority = .init(999)
    countWidth = countPill.widthAnchor.constraint(equalToConstant: 22)
    NSLayoutConstraint.activate([
      card.topAnchor.constraint(equalTo: contentView.topAnchor),
      card.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      card.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
      card.heightAnchor.constraint(equalToConstant: SLStatusCell.cardHeight),
      bottom,

      // Avatar 52 a 18 da borda (o anel de 62 transborda 5 para fora).
      avatar.widthAnchor.constraint(equalToConstant: SLAvatarView.side),
      avatar.heightAnchor.constraint(equalToConstant: SLAvatarView.side),
      avatar.centerYAnchor.constraint(equalTo: card.centerYAnchor),
      avatar.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 13),

      nameLabel.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 11),
      nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -18),
      nameLabel.bottomAnchor.constraint(equalTo: card.centerYAnchor, constant: 0),

      timeLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
      timeLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 3),

      countPill.leadingAnchor.constraint(equalTo: timeLabel.trailingAnchor, constant: 8),
      countPill.centerYAnchor.constraint(equalTo: timeLabel.centerYAnchor),
      countPill.heightAnchor.constraint(equalToConstant: 16),
      countWidth,
      countPill.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -18),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: SLRow, palette p: SLPalette) {
    palette = p
    card.backgroundColor = isHighlighted ? blend(p.card, p.press) : p.card
    avatar.configure(row, palette: p)
    nameLabel.text = row.title
    nameLabel.textColor = p.text
    timeLabel.text = row.time
    timeLabel.textColor = p.sub
    if row.count > 1 {
      countPill.isHidden = false
      countPill.text = "\(row.count)"
      countPill.textColor = p.sub
      countPill.backgroundColor = p.pillBg
      let w = ceil(("\(row.count)" as NSString).size(withAttributes: [.font: countPill.font as Any]).width) + 14
      countWidth.constant = max(16, w)
    } else {
      countPill.isHidden = true
    }
    isAccessibilityElement = true
    accessibilityLabel = row.a11y.isEmpty ? row.title : row.a11y
    accessibilityTraits = .button
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.05 : 0.2) {
        self.card.backgroundColor = self.isHighlighted ? self.blend(self.palette.card, self.palette.press) : self.palette.card
        self.card.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.985, y: 0.985) : .identity
      }
    }
  }

  private func blend(_ base: UIColor, _ over: UIColor) -> UIColor {
    var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
    var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
    base.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
    over.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
    return UIColor(red: r1 * (1 - a2) + r2 * a2, green: g1 * (1 - a2) + g2 * a2, blue: b1 * (1 - a2) + b2 * a2, alpha: 1)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    card.transform = .identity
  }
}

/// Cabeçalho de seção (RECENTES · 3), "Silenciados" com chevron recolhível.
final class SLSectionCell: UICollectionViewListCell {
  private let titleLabel = UILabel()
  private let countLabel = UILabel()
  private let chevron = UIImageView()
  private var countToChevron: NSLayoutConstraint!
  private var countToEdge: NSLayoutConstraint!

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundConfiguration = UIBackgroundConfiguration.clear()
    titleLabel.font = UIFont.systemFont(ofSize: 12, weight: .semibold)
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(titleLabel)
    countLabel.font = UIFont.systemFont(ofSize: 11, weight: .semibold)
    countLabel.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(countLabel)
    chevron.contentMode = .center
    chevron.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(chevron)
    let h = contentView.heightAnchor.constraint(equalToConstant: 14 + 36)
    h.priority = .init(999)
    countToChevron = countLabel.trailingAnchor.constraint(equalTo: chevron.leadingAnchor, constant: -16)
    countToEdge = countLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -34)
    NSLayoutConstraint.activate([
      h,
      titleLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 34),
      titleLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -10),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: countLabel.leadingAnchor, constant: -8),
      countLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
      chevron.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
      chevron.widthAnchor.constraint(equalToConstant: 16),
      chevron.heightAnchor.constraint(equalToConstant: 16),
      chevron.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -34),
      countToEdge,
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: SLRow, palette p: SLPalette) {
    let kern: [NSAttributedString.Key: Any] = [.kern: 0.6]
    titleLabel.attributedText = NSAttributedString(string: row.title.uppercased(), attributes: kern)
    titleLabel.textColor = p.sub
    countLabel.text = row.count > 0 ? "\(row.count)" : ""
    countLabel.textColor = p.sub
    // Desativa antes de ativar (evita conflito transitório no log).
    if row.collapsible { countToEdge.isActive = false; countToChevron.isActive = true }
    else { countToChevron.isActive = false; countToEdge.isActive = true }
    if row.collapsible {
      chevron.isHidden = false
      chevron.image = UIImage(systemName: row.expanded ? "chevron.up" : "chevron.down",
                              withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))?
        .withTintColor(p.sub, renderingMode: .alwaysOriginal)
      isAccessibilityElement = true
      accessibilityLabel = "\(row.title), \(row.count)"
      accessibilityTraits = [.button, .header]
    } else {
      chevron.isHidden = true
      chevron.image = nil
      isAccessibilityElement = true
      accessibilityLabel = "\(row.title), \(row.count)"
      accessibilityTraits = .header
    }
  }
}
