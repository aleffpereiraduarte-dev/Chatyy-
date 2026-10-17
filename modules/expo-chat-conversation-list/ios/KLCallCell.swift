import UIKit

// [2026-10-15 native-calls] Linha do histórico de ligações (aba Ligações).
// Visual = CallHistoryRow do components/ChatCallsTab.js: avatar 44 dentro de
// um aro de 51 (vermelho quando perdida), nome 16/600 (vermelho se perdida),
// linha 2 com seta entrada/saída (verde/cinza/vermelho) + "Chatyy"/número +
// câmera (vídeo) + duração + microfone (recado), hora 12 tabular, botão
// redondo de ligar (40) e "i". Cartões arredondados por seção (inset grouped).
// Layout manual (frames) com altura fixa por categoria de fonte.

/// Paleta da aba Ligações (mesmos hex do ChatCallsTab.js).
struct KLTheme {
  let dark: Bool
  let bg: UIColor
  let card: UIColor
  let text: UIColor
  let sub: UIColor
  let hair: UIColor
  let ink: UIColor
  let btnBg: UIColor
  let press: UIColor
  let red = UIColor(clHex: 0xE53935)
  let green = UIColor(clHex: 0x16A34A)

  init(dark: Bool) {
    self.dark = dark
    if dark {
      bg = UIColor.black
      card = UIColor(clHex: 0x1C1C1E)
      text = UIColor.white
      sub = UIColor(clHex: 0x8E8E93)
      hair = UIColor(white: 1, alpha: 0.08)
      ink = UIColor(clHex: 0xF5F5F7)
      btnBg = UIColor(clHex: 0x2C2C2E)
      press = UIColor(clHex: 0x2C2C2E)
    } else {
      bg = UIColor(clHex: 0xF2F2F7)
      card = UIColor.white
      text = UIColor.black
      sub = UIColor(clHex: 0x6C6C70)
      hair = UIColor(white: 0, alpha: 0.08)
      ink = UIColor(clHex: 0x111111)
      btnBg = UIColor(clHex: 0xF2F2F7)
      press = UIColor(clHex: 0xE5E5EA)
    }
  }
}

/// Linha já pronta para desenhar (montada no JS — components/calls/NativeCallList.js).
struct KLRow {
  var id: String = ""
  var title: String = ""
  var dir: String = "in"        // in | out | missed
  var video: Bool = false
  var sub: String = ""          // "Chatyy" / número formatado / rótulo
  var dur: String = ""          // "1:23"
  var vm: Bool = false          // recado de voz anexado
  var time: String = ""
  var flag: String = ""         // bandeira do país (linhas de telefone)
  var phone: Bool = false       // avatar de telefone (sem foto/iniciais)
  var count: Int = 0            // chamadas agregadas "(3)"
  var sec: String = ""          // rótulo da seção (Hoje, Ontem…)
  var a11y: String = ""
  var avatar = CLRow()          // reaproveita o CLAvatarView (tiles/colagem)

  init() {}

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    title = CLVal.str(d["title"])
    dir = CLVal.str(d["dir"])
    if dir.isEmpty { dir = "in" }
    video = CLVal.bool(d["video"])
    sub = CLVal.str(d["sub"])
    dur = CLVal.str(d["dur"])
    vm = CLVal.bool(d["vm"])
    time = CLVal.str(d["time"])
    flag = CLVal.str(d["flag"])
    phone = CLVal.bool(d["phone"])
    count = CLVal.int(d["count"])
    sec = CLVal.str(d["sec"])
    a11y = CLVal.str(d["a11y"])
    var av: [String: Any] = ["id": id, "kind": CLVal.str(d["kind"]).isEmpty ? "direct" : CLVal.str(d["kind"])]
    if let tiles = d["tiles"] as? [Any] { av["tiles"] = tiles }
    avatar = CLRow(av)
  }

  var missed: Bool { dir == "missed" }
}

final class KLCallCell: UICollectionViewListCell {
  static let ringBox: CGFloat = 51
  static let avatarBox: CGFloat = 44

  private let ring = UIView()
  private let avatar = CLAvatarView()
  private let phoneCircle = UIView()
  private let phoneIcon = UIImageView()
  private let flagLabel = UILabel()
  private let nameLabel = UILabel()
  private let subLabel = UILabel()
  private let timeLabel = UILabel()
  private let callButton = UIButton(type: .system)
  private let infoButton = UIButton(type: .system)

  private(set) var row = KLRow()
  private var theme = KLTheme(dark: false)
  private var labels = CLLabels()
  private var fontsCategory: UIContentSizeCategory?
  private var nameFont = UIFont.systemFont(ofSize: 16, weight: .semibold)
  private var subFont = UIFont.systemFont(ofSize: 13, weight: .regular)
  private var timeFont = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)

  var onAction: ((String, String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    let cv = contentView
    ring.isUserInteractionEnabled = false
    ring.layer.borderWidth = 2
    ring.layer.cornerRadius = KLCallCell.ringBox / 2
    ring.layer.borderColor = UIColor.clear.cgColor
    cv.addSubview(ring)
    avatar.isUserInteractionEnabled = false
    avatar.boxSize = KLCallCell.avatarBox
    cv.addSubview(avatar)
    phoneCircle.isUserInteractionEnabled = false
    phoneCircle.layer.cornerRadius = KLCallCell.avatarBox / 2
    phoneCircle.clipsToBounds = true
    cv.addSubview(phoneCircle)
    phoneIcon.contentMode = .center
    phoneCircle.addSubview(phoneIcon)
    flagLabel.textAlignment = .center
    flagLabel.font = UIFont.systemFont(ofSize: 20)
    phoneCircle.addSubview(flagLabel)
    for l in [nameLabel, subLabel, timeLabel] {
      l.numberOfLines = 1
      l.lineBreakMode = .byTruncatingTail
      l.adjustsFontForContentSizeCategory = false
      cv.addSubview(l)
    }
    timeLabel.textAlignment = .right
    callButton.layer.cornerRadius = 20
    callButton.addTarget(self, action: #selector(callTapped), for: .touchUpInside)
    cv.addSubview(callButton)
    infoButton.addTarget(self, action: #selector(infoTapped), for: .touchUpInside)
    cv.addSubview(infoButton)
    isAccessibilityElement = true
    accessibilityTraits = .button
    reloadFonts(force: true)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: - Altura

  static func height(for traits: UITraitCollection) -> CGFloat {
    let name = CLFonts.scaled(16, .semibold, cap: 1.35, traits: traits)
    let sub = CLFonts.scaled(13, .regular, cap: 1.3, traits: traits)
    return max(66, ceil(22 + ceil(name.lineHeight) + 2 + ceil(sub.lineHeight)))
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes) -> UICollectionViewLayoutAttributes {
    let attrs = super.preferredLayoutAttributesFitting(layoutAttributes)
    attrs.frame.size.height = KLCallCell.height(for: traitCollection)
    return attrs
  }

  private func reloadFonts(force: Bool = false) {
    let cat = traitCollection.preferredContentSizeCategory
    if !force, cat == fontsCategory { return }
    fontsCategory = cat
    let tc = traitCollection
    nameFont = CLFonts.scaled(16, .semibold, cap: 1.35, traits: tc)
    subFont = CLFonts.scaled(13, .regular, cap: 1.3, traits: tc)
    timeFont = CLFonts.scaled(12, .medium, cap: 1.3, traits: tc, mono: true)
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    if previousTraitCollection?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory {
      reloadFonts()
      apply()
    }
  }

  // MARK: - Configuração

  func configure(_ newRow: KLRow, theme: KLTheme, labels: CLLabels) {
    self.row = newRow
    self.theme = theme
    self.labels = labels
    reloadFonts()
    apply()
    setNeedsUpdateConfiguration()
  }

  private func symbol(_ name: String, _ size: CGFloat, _ color: UIColor, weight: UIImage.SymbolWeight = .semibold) -> UIImage? {
    return CLSymbols.image(name, pointSize: size, weight: weight, color: color)
  }

  private func attachment(_ name: String, color: UIColor) -> NSAttributedString? {
    guard let img = symbol(name, 10, color) else { return nil }
    let att = NSTextAttachment()
    att.image = img
    let h: CGFloat = 12
    let w = img.size.height > 0 ? img.size.width * h / img.size.height : h
    att.bounds = CGRect(x: 0, y: (subFont.capHeight - h) / 2, width: w, height: h)
    return NSAttributedString(attachment: att)
  }

  private func apply() {
    let r = row
    let t = theme
    // Aro vermelho só nas perdidas.
    ring.layer.borderColor = (r.missed ? t.red : UIColor.clear).cgColor
    // Avatar: foto/iniciais/colagem (Chatyy) ou círculo com bandeira/telefone.
    if r.phone {
      avatar.isHidden = true
      phoneCircle.isHidden = false
      phoneCircle.backgroundColor = t.btnBg
      if r.flag.isEmpty {
        flagLabel.isHidden = true
        phoneIcon.isHidden = false
        phoneIcon.image = symbol("phone", 18, t.sub, weight: .regular)
      } else {
        phoneIcon.isHidden = true
        flagLabel.isHidden = false
        flagLabel.text = r.flag
      }
    } else {
      phoneCircle.isHidden = true
      avatar.isHidden = false
      avatar.configure(r.avatar, theme: CLTheme(dark: t.dark), rowBackground: t.card)
    }
    // Nome (+ contagem agregada)
    nameLabel.font = nameFont
    nameLabel.textColor = r.missed ? t.red : t.text
    nameLabel.text = r.count > 1 ? "\(r.title) (\(r.count))" : r.title
    // Linha 2: seta + origem + vídeo + duração + recado
    let s = NSMutableAttributedString()
    let arrowColor: UIColor = r.missed ? t.red : t.sub // [2026-10-16 P&B] recebida = cinza (verde só no botão)
    if let a = attachment(r.dir == "out" ? "arrow.up.right" : "arrow.down.left", color: arrowColor) {
      s.append(a)
      s.append(NSAttributedString(string: " "))
    }
    let attrs: [NSAttributedString.Key: Any] = [.font: subFont, .foregroundColor: t.sub]
    s.append(NSAttributedString(string: r.sub, attributes: attrs))
    if r.video, let v = attachment("video", color: t.sub) {
      s.append(NSAttributedString(string: " ", attributes: attrs))
      s.append(v)
    }
    if !r.dur.isEmpty {
      s.append(NSAttributedString(string: " " + r.dur, attributes: attrs))
    }
    if r.vm, let m = attachment("mic", color: t.red) {
      s.append(NSAttributedString(string: "  ", attributes: attrs))
      s.append(m)
    }
    subLabel.attributedText = s
    timeLabel.font = timeFont
    timeLabel.textColor = t.sub
    timeLabel.text = r.time
    callButton.backgroundColor = t.btnBg
    callButton.setImage(symbol(r.video ? "video" : "phone", 16, t.ink, weight: .medium), for: .normal)
    callButton.tintColor = t.ink
    callButton.accessibilityLabel = labels.get("callBack", "Ligar de volta")
    infoButton.setImage(symbol("info.circle", 19, t.ink, weight: .regular), for: .normal)
    infoButton.tintColor = t.ink
    infoButton.accessibilityLabel = labels.get("info", "Info")
    accessibilityLabel = r.a11y.isEmpty ? r.title : r.a11y
    accessibilityCustomActions = buildA11yActions()
    setNeedsLayout()
  }

  private func buildA11yActions() -> [UIAccessibilityCustomAction] {
    let id = row.id
    let list: [(String, String)] = [
      ("callBack", labels.get("callBack", "Ligar de volta")),
      ("info", labels.get("info", "Info")),
      ("delete", labels.get("delete", "Apagar")),
    ]
    return list.map { (action, title) in
      UIAccessibilityCustomAction(name: title) { [weak self] _ in
        self?.onAction?(id, action)
        return true
      }
    }
  }

  @objc private func callTapped() {
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onAction?(row.id, "callBack")
  }

  @objc private func infoTapped() {
    onAction?(row.id, "info")
  }

  // MARK: - Fundo (cartão / pressionado)

  override func updateConfiguration(using state: UICellConfigurationState) {
    var bg = UIBackgroundConfiguration.listGroupedCell()
    bg.backgroundColor = (state.isHighlighted || state.isSelected || state.isSwiped) ? theme.press : theme.card
    backgroundConfiguration = bg
  }

  // MARK: - Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let W = b.width
    let H = b.height
    let rb = KLCallCell.ringBox
    let ab = KLCallCell.avatarBox
    let x: CGFloat = 16
    ring.frame = CGRect(x: x, y: (H - rb) / 2, width: rb, height: rb)
    let af = CGRect(x: x + (rb - ab) / 2, y: (H - ab) / 2, width: ab, height: ab)
    avatar.frame = af
    phoneCircle.frame = af
    phoneIcon.frame = phoneCircle.bounds
    flagLabel.frame = phoneCircle.bounds
    let textX = x + rb + 13
    // Direita: [hora] 10 [ligar 40] 10 [i 28] 16
    var right = W - 16
    infoButton.frame = CGRect(x: right - 28, y: (H - 28) / 2, width: 28, height: 28)
    right -= 28 + 10
    callButton.frame = CGRect(x: right - 40, y: (H - 40) / 2, width: 40, height: 40)
    right -= 40 + 10
    let tw = min(ceil(timeLabel.sizeThatFits(CGSize(width: 160, height: 40)).width), 140)
    let th = ceil(timeFont.lineHeight)
    timeLabel.frame = CGRect(x: right - tw, y: (H - th) / 2, width: tw, height: th)
    right -= tw + 10
    let nameH = ceil(nameFont.lineHeight)
    let subH = ceil(subFont.lineHeight) + 2
    let top = (H - (nameH + 2 + subH)) / 2
    let textW = max(0, right - textX)
    nameLabel.frame = CGRect(x: textX, y: top, width: textW, height: nameH)
    subLabel.frame = CGRect(x: textX, y: top + nameH + 2, width: textW, height: subH)
  }
}
