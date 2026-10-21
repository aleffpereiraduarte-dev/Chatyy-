import UIKit

// [2026-10-14 native-home] Avatar da linha: foto (ou colagem 2–4 do grupo),
// iniciais sobre gradiente cinza, ícone de canal, anel de status segmentado
// (CoreGraphics), bolinha online e balão de nota.
// Geometria = ConversationRow do JS: caixa 54 pt; com anel a foto encolhe
// para 46 pt (margem 4) e o anel ocupa a caixa inteira.

/// Anel segmentado (um arco por status). NÃO visto = traço 2.5 destacado;
/// visto = traço 1.5 cinza. Port de components/status/AvatarStatusRing.js.
final class CLRingView: UIView {
  var viewed: [Bool] = [] { didSet { setNeedsDisplay() } }
  var hot: UIColor = .black { didSet { setNeedsDisplay() } }
  var cold: UIColor = .gray { didSet { setNeedsDisplay() } }
  /// [2026-10-21 pitada-azul] fim do gradiente do NÃO visto (hot → hot2, diagonal). nil = cor sólida.
  var hot2: UIColor? = nil { didSet { setNeedsDisplay() } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func draw(_ rect: CGRect) {
    let n = max(1, min(viewed.count, 30))
    if viewed.isEmpty { return }
    guard let ctx = UIGraphicsGetCurrentContext() else { return }
    let outer = min(bounds.width, bounds.height)
    let sw: CGFloat = 2.5
    let r = (outer - sw) / 2
    let c = CGPoint(x: bounds.midX, y: bounds.midY)
    let circ = 2 * CGFloat.pi * r
    let gapLen: CGFloat = n > 1 ? min(circ * 0.04, 6) : 0
    let seg = circ / CGFloat(n) - gapLen
    ctx.setLineCap(n > 1 ? .round : .butt)
    for i in 0..<n {
      let v = i < viewed.count ? viewed[i] : true
      let start = -CGFloat.pi / 2 + (CGFloat(i) * (seg + gapLen)) / r
      let end = n > 1 ? start + seg / r : start + 2 * CGFloat.pi
      if !v, let h2 = hot2,
         let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [hot.cgColor, h2.cgColor] as CFArray, locations: [0, 1]) {
        // Segmento NÃO visto com gradiente (claro no alto-esquerda → escuro embaixo-direita).
        ctx.saveGState()
        ctx.setLineWidth(sw)
        ctx.beginPath()
        ctx.addArc(center: c, radius: r, startAngle: start, endAngle: end, clockwise: false)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        ctx.drawLinearGradient(grad, start: CGPoint(x: bounds.minX, y: bounds.minY), end: CGPoint(x: bounds.maxX, y: bounds.maxY), options: [])
        ctx.restoreGState()
        continue
      }
      ctx.setStrokeColor((v ? cold : hot).cgColor)
      ctx.setLineWidth(v ? 1.5 : sw)
      ctx.beginPath()
      ctx.addArc(center: c, radius: r, startAngle: start, endAngle: end, clockwise: false)
      ctx.strokePath()
    }
  }
}

/// Um ladrilho: gradiente + iniciais por baixo, foto por cima quando carrega.
final class CLTileView: UIView {
  private let gradient = CAGradientLayer()
  private let initialsLabel = UILabel()
  private let imageView = UIImageView()
  private var currentURL = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    isUserInteractionEnabled = false
    gradient.startPoint = CGPoint(x: 0, y: 0)
    gradient.endPoint = CGPoint(x: 1, y: 1)
    layer.addSublayer(gradient)
    initialsLabel.textAlignment = .center
    initialsLabel.textColor = .white
    initialsLabel.adjustsFontSizeToFitWidth = true
    initialsLabel.minimumScaleFactor = 0.6
    addSubview(initialsLabel)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    addSubview(imageView)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ tile: CLTile, warm: Bool = false) {
    // [2026-10-21 lista-viva] sem foto = gradiente quente (mesmo `g` = mesma pessoa).
    let (c1, c2) = warm ? CLTheme.warmGradient(tile.warm >= 0 ? tile.warm : tile.grad) : CLTheme.gradient(tile.grad)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.colors = [c1.cgColor, c2.cgColor]
    CATransaction.commit()
    initialsLabel.text = tile.initials
    if tile.url == currentURL, imageView.image != nil { return }
    currentURL = tile.url
    if tile.url.isEmpty {
      imageView.image = nil
      return
    }
    if let img = CLImageLoader.shared.cachedImage(tile.url) {
      imageView.image = img
      imageView.alpha = 1
      return
    }
    imageView.image = nil
    let url = tile.url
    CLImageLoader.shared.load(url, auth: tile.auth) { [weak self] img in
      guard let self = self, self.currentURL == url else { return }
      self.imageView.image = img
      if img != nil && self.window != nil {
        self.imageView.alpha = 0
        UIView.animate(withDuration: 0.18) { self.imageView.alpha = 1 }
      } else {
        self.imageView.alpha = 1
      }
    }
  }

  func reset() {
    currentURL = ""
    imageView.image = nil
    initialsLabel.text = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = bounds
    CATransaction.commit()
    imageView.frame = bounds
    let side = min(bounds.width, bounds.height)
    initialsLabel.font = UIFont.systemFont(ofSize: max(9, side * 0.38), weight: .bold)
    initialsLabel.frame = bounds.insetBy(dx: 2, dy: 0)
  }
}

final class CLAvatarView: UIView {
  static let box: CGFloat = 54

  private let ringView = CLRingView()
  private let clip = UIView()
  private var tileViews: [CLTileView] = []
  private let channelIcon = UIImageView()
  private let onlineDot = UIView()
  private let noteLabel = CLPaddedLabel()
  private var tilesKey = ""
  private var hasRing = false
  private var tileCount = 0
  private var isChannel = false
  var theme = CLTheme(dark: false)
  /// [2026-10-21 lista-viva, apiVersion 11] avatar quente + ponto online
  /// #2FB36B com pulso. Só a linha da lista liga (fixados/prévia não).
  var vivo = false
  private var pulse: CAShapeLayer?
  private var pulseOn = false
  /// [2026-10-15 native-pins] Lado da caixa (54 na linha; a fileira de
  /// fixados usa avatares maiores com o mesmo desenho).
  var boxSize: CGFloat = CLAvatarView.box {
    didSet { if boxSize != oldValue { setNeedsLayout(); ringView.setNeedsDisplay() } }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = false
    addSubview(ringView)
    clip.clipsToBounds = true
    clip.isUserInteractionEnabled = false
    addSubview(clip)
    channelIcon.contentMode = .center
    clip.addSubview(channelIcon)
    onlineDot.isUserInteractionEnabled = false
    onlineDot.layer.borderWidth = 2.5
    onlineDot.isHidden = true
    addSubview(onlineDot)
    noteLabel.font = UIFont.systemFont(ofSize: 9, weight: .semibold)
    noteLabel.textAlignment = .center
    noteLabel.layer.cornerRadius = 9
    noteLabel.layer.borderWidth = 1.5
    noteLabel.clipsToBounds = true
    noteLabel.isHidden = true
    addSubview(noteLabel)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: CLRow, theme: CLTheme, rowBackground: UIColor) {
    self.theme = theme
    isChannel = row.kind == "channel"
    // Anel: só direct (o JS também só calcula para direct).
    let viewed = row.ring.map { $0 == "1" }
    hasRing = !viewed.isEmpty && !row.isGroupish
    ringView.isHidden = !hasRing
    if hasRing {
      ringView.hot = theme.ringNew ?? theme.ringHot
      ringView.hot2 = theme.ringNew != nil ? theme.ringNew2 : nil
      ringView.cold = theme.ringCold
      ringView.viewed = viewed
    }
    // Ladrilhos
    if isChannel {
      tilesKey = row.tilesKey
      for t in tileViews { t.isHidden = true }
      tileCount = 0
      clip.backgroundColor = theme.card
      channelIcon.isHidden = false
      channelIcon.image = CLSymbols.image("megaphone", pointSize: 20, weight: .medium, color: theme.text)
    } else {
      channelIcon.isHidden = true
      clip.backgroundColor = UIColor(clHex: 0x333333)
      let tiles = row.tiles.isEmpty ? [CLTile([:])] : Array(row.tiles.prefix(4))
      while tileViews.count < tiles.count {
        let tv = CLTileView()
        clip.insertSubview(tv, belowSubview: channelIcon)
        tileViews.append(tv)
      }
      for (i, tv) in tileViews.enumerated() {
        if i < tiles.count {
          tv.isHidden = false
          tv.configure(tiles[i], warm: vivo)
        } else {
          tv.isHidden = true
          tv.reset()
        }
      }
      if tileCount != tiles.count { tileCount = tiles.count; setNeedsLayout() }
      tilesKey = row.tilesKey
    }
    // Online
    onlineDot.isHidden = !row.online
    onlineDot.backgroundColor = vivo ? CLTheme.onlineVivo : theme.online
    onlineDot.layer.borderColor = rowBackground.cgColor
    setPulse(vivo && row.online)
    // Nota (estilo Instagram) acima do avatar
    if row.note.isEmpty {
      noteLabel.isHidden = true
    } else {
      noteLabel.isHidden = false
      noteLabel.text = row.note
      noteLabel.textColor = theme.text
      noteLabel.backgroundColor = theme.card
      noteLabel.layer.borderColor = rowBackground.cgColor
    }
    setNeedsLayout()
  }

  // MARK: [2026-10-21 lista-viva] pulso do ponto online
  // Anel 2 pt na cor do ponto, inset −3: escala 0,8→1,7 e some (2 s, ease-out,
  // infinito). Layer criada uma vez; liga/desliga sem recriar. Reduzir
  // Movimento = sem pulso (só o ponto).

  private func setPulse(_ on: Bool) {
    pulseOn = on
    if !on {
      if let p = pulse { p.removeAnimation(forKey: "pulse"); p.isHidden = true }
      return
    }
    if pulse == nil {
      let p = CAShapeLayer()
      p.fillColor = UIColor.clear.cgColor
      p.lineWidth = 2
      p.isHidden = true
      layer.insertSublayer(p, below: onlineDot.layer)
      pulse = p
    }
    pulse?.strokeColor = CLTheme.onlineVivo.cgColor
    startPulseIfNeeded()
  }

  private func startPulseIfNeeded() {
    guard let p = pulse else { return }
    if !pulseOn || CLMotion.reduced || window == nil {
      p.removeAnimation(forKey: "pulse")
      p.isHidden = true
      return
    }
    p.isHidden = false
    if p.animation(forKey: "pulse") != nil { return }
    let sc = CABasicAnimation(keyPath: "transform.scale")
    sc.fromValue = 0.8
    sc.toValue = 1.7
    let op = CABasicAnimation(keyPath: "opacity")
    op.fromValue = 0.7
    op.toValue = 0
    let g = CAAnimationGroup()
    g.animations = [sc, op]
    g.duration = 2
    g.timingFunction = CAMediaTimingFunction(name: .easeOut)
    g.repeatCount = .infinity
    g.isRemovedOnCompletion = false
    CATransaction.begin(); CATransaction.setDisableActions(true)
    p.opacity = 0
    CATransaction.commit()
    p.add(g, forKey: "pulse")
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Animações caem quando a célula sai da janela; religa ao voltar.
    if pulse != nil {
      pulse?.removeAnimation(forKey: "pulse")
      startPulseIfNeeded()
    }
  }

  func updateRowBackground(_ c: UIColor) {
    onlineDot.layer.borderColor = c.cgColor
    noteLabel.layer.borderColor = c.cgColor
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let box = boxSize
    ringView.frame = CGRect(x: 0, y: 0, width: box, height: box)
    // Margem do anel: 4 pt na linha (54); cresce junto nos avatares maiores.
    let ringGap: CGFloat = max(4, (box * 0.075).rounded())
    let inner: CGFloat = hasRing ? box - ringGap * 2 : box
    let off: CGFloat = hasRing ? ringGap : 0
    clip.frame = CGRect(x: off, y: off, width: inner, height: inner)
    clip.layer.cornerRadius = inner / 2
    channelIcon.frame = clip.bounds
    let half = inner / 2
    let visible = tileViews.filter { !$0.isHidden }
    switch visible.count {
    case 0: break
    case 1:
      visible[0].frame = clip.bounds
    case 2:
      visible[0].frame = CGRect(x: 0, y: 0, width: half, height: inner)
      visible[1].frame = CGRect(x: half, y: 0, width: half, height: inner)
    case 3:
      visible[0].frame = CGRect(x: 0, y: 0, width: half, height: inner)
      visible[1].frame = CGRect(x: half, y: 0, width: half, height: half)
      visible[2].frame = CGRect(x: half, y: half, width: half, height: half)
    default:
      // Mesma ordem do _GroupCollage: [0 ↖, 2 ↙] [1 ↗, 3 ↘]
      visible[0].frame = CGRect(x: 0, y: 0, width: half, height: half)
      visible[1].frame = CGRect(x: half, y: 0, width: half, height: half)
      visible[2].frame = CGRect(x: 0, y: half, width: half, height: half)
      visible[3].frame = CGRect(x: half, y: half, width: half, height: half)
    }
    if vivo && box <= 60.5 {
      // Mockup: 15 pt com borda 2,5 na cor do fundo, encostado no canto (1 pt).
      onlineDot.frame = CGRect(x: box - 16, y: box - 16, width: 15, height: 15)
      onlineDot.layer.cornerRadius = 7.5
    } else if box <= CLAvatarView.box + 0.5 {
      onlineDot.frame = CGRect(x: box - 15, y: box - 15, width: 14, height: 14)
      onlineDot.layer.cornerRadius = 7
    } else {
      // Avatar grande (fixados): bolinha proporcional, sobre a borda a 45°.
      let dot = (box * 0.22).rounded()
      let o = box / 2 + box / 2 * 0.7071 - dot / 2
      onlineDot.frame = CGRect(x: o, y: o, width: dot, height: dot)
      onlineDot.layer.cornerRadius = dot / 2
    }
    if let p = pulse {
      let f = onlineDot.frame.insetBy(dx: -3, dy: -3)
      CATransaction.begin(); CATransaction.setDisableActions(true)
      p.bounds = CGRect(origin: .zero, size: f.size)
      p.position = CGPoint(x: f.midX, y: f.midY)
      p.path = UIBezierPath(ovalIn: CGRect(origin: .zero, size: f.size).insetBy(dx: 1, dy: 1)).cgPath
      CATransaction.commit()
    }
    if !noteLabel.isHidden {
      let h: CGFloat = 18
      noteLabel.frame = CGRect(x: -4, y: -6, width: box + 8, height: h)
    }
  }
}

/// UILabel com respiro horizontal (balão da nota).
final class CLPaddedLabel: UILabel {
  var inset = UIEdgeInsets(top: 1, left: 5, bottom: 1, right: 5)
  override func drawText(in rect: CGRect) {
    super.drawText(in: rect.inset(by: inset))
  }
}
