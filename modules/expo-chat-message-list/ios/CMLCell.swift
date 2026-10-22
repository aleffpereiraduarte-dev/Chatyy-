import UIKit

// [2026-10-14 native-list] Célula única para todos os tipos de linha. Todas as
// subviews existem desde o init e só são mostradas/posicionadas conforme o
// CMLRowLayout (frames prontos — sem Auto Layout, sem medição na main).
// A lista é invertida (scaleY -1), então o contentView é desvirado aqui.

final class CMLCell: UICollectionViewCell {
  static let reuseId = "cml"

  /// Tudo que desliza no arrastar-p/-responder.
  let slide = UIView()
  let bubble = CAShapeLayer()
  /// [2026-10-20 grafite] gradiente da bolha própria (máscara = caminho da bolha,
  /// com rabicho) + reflexo de 1 px no topo. Só existem quando o tema pede.
  private var ownGrad: CAGradientLayer?
  private var ownGradMask: CAShapeLayer?
  private var ownShine: CAShapeLayer?
  let highlight = UIView()
  let nameView = CMLTextView()
  let fwdView = CMLTextView()
  let fwdIcon = CMLIconView()   // [2026-10-17 fwd-label]
  let reply = CMLReplyView()
  let media = UIImageView()
  let playBadge = CMLIconView()
  let durLabel = CMLTextView()
  let progress = CMLProgressView()   // legado (apiVersion < 5 não usa mais; mantido p/ binário antigo)
  // [2026-10-15 native-media-dl] anel único de transferência (baixar/enviar)
  let xRing = CMLTransferRing()
  let mediaDim = UIView()
  /// [2026-10-18 media-edge] contorno fino da mídia SEM bolha (visual tg, rente):
  /// foto com áreas brancas (print de tela) sumia no fundo branco da conversa e
  /// parecia "faixa em branco" no meio da imagem (print do founder 18/10).
  let mediaEdge = CAShapeLayer()
  /// [2026-10-19 perf-scroll] o contorno mora numa view IRMÃ da mídia (por cima),
  /// não como subcamada dela: subcamada + cornerRadius/masksToBounds = passe
  /// offscreen por quadro; sozinha, a camada da imagem recorta no caminho rápido.
  private let mediaEdgeHost = UIView()
  var albumRings: [CMLTransferRing] = []
  let audioRing = CMLTransferRing()
  let fileRing = CMLTransferRing()
  /// chaves de transferência mostradas nesta célula (p/ a lista só atualizar quem importa)
  private(set) var transferKeys = Set<String>()
  fileprivate var style0: CMLStyle?
  var albumViews: [UIImageView] = []
  let moreLabel = CMLTextView()
  let moreDim = UIView()
  let textView = CMLTextView()
  let deletedIcon = CMLIconView()
  let meta = CMLMetaView()
  let audio = CMLAudioView()
  let fileView = CMLFileView()
  let reacts = CMLReactsView()
  let selIcon = CMLIconView()
  let replyIcon = CMLIconView()
  // pílulas
  let pillBg = UIView()
  let pillText = CMLTextView()
  /// [2026-10-19 perf-scroll] tg-style SEM UIVisualEffectView por célula: até ~8
  /// desfoques por tela (data/sistema, hora sobre mídia, duração) custavam 1 passe
  /// de desfoque + offscreen CADA quadro da rolagem (slow frames 10,5‰ → 32,7‰ da
  /// 723 à 732). Agora: pílulas chapadas translúcidas com a cor "fosca" pré-composta
  /// (CMLLook.frostedPill). Desfoque real fica SÓ na pílula flutuante (CMLSticky).
  /// Pílula da duração do vídeo (só CMLStyle.ts) — view simples, criada sob demanda.
  private var durPill: UIView?
  // [fase 2]
  let blocks = CMLBlocksView()
  let failIcon = CMLIconView()
  /// (key, "play"|"pause"|"end") da nota de vídeo
  var onVideoNote: ((String, String) -> Void)?
  /// [wave13-C a11y] toque duplo do VoiceOver → ação principal da bolha (a lista decide)
  var onA11yActivate: ((CMLCell) -> Bool)?
  private var revealed = false
  private var lifted = false
  /// [tg-list] emoji do toque duplo voando
  fileprivate var quickPop: UILabel?
  /// [2026-10-15 native-effects] emoji grande aguardando o willDisplay p/ animar 1×
  private var jumboPending = false

  private(set) var key: String = ""
  private(set) var row: CMLRow?
  private(set) var layoutInfo: CMLRowLayout?
  private var mediaToken = ""
  private var albumTokens: [String] = []
  /// [2026-10-18 vthumb] slot (-1 mídia única, 0..3 álbum) → URL do vídeo cujo 1º frame está em voo
  private var vfReq: [Int: String] = [:]
  /// [2026-10-18 lqip] slot → token cuja imagem DEFINITIVA (não a LQIP) já está na tela
  private var fullTok: [Int: String] = [:]
  /// [2026-10-18 lqip] slot → tentativas de recarga do pôster que falhou (2 s, 6 s, 15 s)
  private var retryN: [Int: Int] = [:]
  private var retryArmed: Set<Int> = []
  /// [perf-scroll] cache do caminho do contorno (só refaz se tamanho/cantos mudarem)
  private var mediaEdgeCorners: [CGFloat] = []
  private var mediaEdgeRadius: CGFloat = -1

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.transform = CGAffineTransform(scaleX: 1, y: -1)
    contentView.isUserInteractionEnabled = false
    backgroundColor = .clear
    contentView.backgroundColor = .clear

    highlight.alpha = 0
    highlight.isUserInteractionEnabled = false
    contentView.addSubview(highlight)

    pillBg.isUserInteractionEnabled = false
    contentView.addSubview(pillBg)
    contentView.addSubview(pillText)

    replyIcon.kind = .reply
    replyIcon.alpha = 0
    contentView.addSubview(replyIcon)
    selIcon.isHidden = true
    contentView.addSubview(selIcon)
    failIcon.kind = .failed
    failIcon.isHidden = true
    contentView.addSubview(failIcon)

    slide.isUserInteractionEnabled = false
    contentView.addSubview(slide)
    slide.layer.addSublayer(bubble)
    slide.addSubview(nameView)
    slide.addSubview(fwdView)
    fwdIcon.kind = .forward
    slide.addSubview(fwdIcon)
    slide.addSubview(reply)
    media.contentMode = .scaleAspectFill
    media.clipsToBounds = true
    mediaEdge.fillColor = UIColor.clear.cgColor
    mediaEdgeHost.isUserInteractionEnabled = false
    mediaEdgeHost.isHidden = true
    mediaEdgeHost.layer.addSublayer(mediaEdge)
    slide.addSubview(media)
    slide.addSubview(mediaEdgeHost)
    for _ in 0..<4 {
      let iv = UIImageView()
      iv.contentMode = .scaleAspectFill
      iv.clipsToBounds = true
      iv.layer.cornerRadius = 4
      iv.isHidden = true
      slide.addSubview(iv)
      albumViews.append(iv)
    }
    moreDim.backgroundColor = UIColor(white: 0, alpha: 0.45)
    moreDim.isHidden = true
    slide.addSubview(moreDim)
    slide.addSubview(moreLabel)
    playBadge.kind = .play
    playBadge.color = .white
    playBadge.disc = UIColor(white: 0, alpha: 0.45)
    slide.addSubview(playBadge)
    slide.addSubview(durLabel)
    slide.addSubview(progress)
    progress.isHidden = true
    mediaDim.backgroundColor = UIColor(white: 0, alpha: 0.18)
    mediaDim.isUserInteractionEnabled = false
    mediaDim.isHidden = true
    slide.insertSubview(mediaDim, aboveSubview: media)
    slide.addSubview(xRing)
    for _ in 0..<4 {
      let r = CMLTransferRing()
      slide.addSubview(r)
      albumRings.append(r)
    }
    slide.addSubview(textView)
    deletedIcon.kind = .deleted
    slide.addSubview(deletedIcon)
    slide.addSubview(audio)
    slide.addSubview(fileView)
    audioRing.look = .inline
    fileRing.look = .inline
    slide.addSubview(audioRing)
    slide.addSubview(fileRing)
    slide.addSubview(blocks)
    blocks.onVideoNoteEvent = { [weak self] _, st in
      guard let self = self else { return }
      self.onVideoNote?(self.key, st)
    }
    slide.addSubview(meta)
    slide.addSubview(reacts)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func prepareForReuse() {
    super.prepareForReuse()
    blocks.stopMedia()
    slide.layer.removeAllAnimations()
    selIcon.layer.removeAllAnimations()
    selIcon.alpha = 1
    selIcon.transform = .identity
    slide.transform = .identity
    reacts.layer.removeAllAnimations()
    reacts.transform = .identity
    reacts.alpha = 1
    meta.cancelStatusAnim()
    meta.setClockSpin(false, key: "")
    textView.setMarks([], color: .clear)
    quickPop?.removeFromSuperview(); quickPop = nil
    audio.resetPlayback()
    audio.rateText = nil // [voz-wa]
    replyIcon.alpha = 0
    highlight.layer.removeAllAnimations()
    highlight.alpha = 0
    progress.stop()
    xRing.reset(); audioRing.reset(); fileRing.reset()
    for r in albumRings { r.reset() }
    mediaDim.isHidden = true
    transferKeys = []
    textView.layer.removeAnimation(forKey: CMLJumboFX.animKey)
    jumboPending = false
    mediaToken = ""
    albumTokens = []
    for (_, v) in vfReq { CMLVideoFrameLoader.shared.cancel(v) }
    vfReq = [:]
    fullTok = [:]
    retryN = [:]
    retryArmed = []
    media.image = nil
    reply.thumb.image = nil
    reply.thumbToken = ""
    for iv in albumViews { iv.image = nil }
  }

  /// [2026-10-15 native-effects] chamado no willDisplay da lista.
  func willAppear() {
    guard jumboPending, let r = row else { return }
    jumboPending = false
    if CMLJumboFX.claim(key) { CMLJumboFX.play(textView, text: r.text) }
  }

  // [wave13-C a11y] o ponto padrão (centro da linha inteira) caía fora de bolhas
  // curtas → toque duplo não fazia nada.
  override func accessibilityActivate() -> Bool {
    if let f = onA11yActivate, f(self) { return true }
    return super.accessibilityActivate()
  }

  // MARK: configure

  func configure(key: String, row: CMLRow, layout L: CMLRowLayout, style s: CMLStyle, audioState: CMLAudioState?, extra: CMLCellExtra = CMLCellExtra()) {
    let prevKey = self.key
    let prevSel = self.row?.sel ?? 0
    let prevOwn = self.row?.own ?? false
    // [motion-conv] p/ animar ✓/✓✓/lida e reação nova de outra pessoa
    let prevStatus = self.row?.status
    let prevReacts = self.row?.reacts ?? []
    self.key = key
    self.row = row
    self.layoutInfo = L
    self.style0 = s
    self.revealed = extra.revealed
    let th = s.theme
    let w = bounds.width > 0 ? bounds.width : s.width
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer {
      CATransaction.commit()
      // [fase 2] entrada/saída do modo seleção animada (mesma linha reconfigurada)
      if prevKey == key && row.kind == .msg && prevSel != row.sel && window != nil && !UIAccessibility.isReduceMotionEnabled {
        let entering = prevSel == 0 && row.sel > 0
        let leaving = prevSel > 0 && row.sel == 0
        let own = row.own || prevOwn
        DispatchQueue.main.async { [weak self] in
          guard let self = self, self.key == key else { return }
          self.animateSelection(entering: entering, leaving: leaving, own: own)
        }
      }
    }
    // [fase 2] opacidade / escondido pelo lift do menu
    lifted = extra.lifted
    contentView.layer.removeAnimation(forKey: "opacity")
    contentView.alpha = lifted ? 0 : 1
    slide.alpha = row.opacity * (row.fail ? 0.5 : 1)
    if row.fail && !L.failFrame.isEmpty && row.kind == .msg {
      failIcon.isHidden = false
      failIcon.color = th.failed
      failIcon.frame = L.failFrame
    } else {
      failIcon.isHidden = true
    }

    highlight.frame = CGRect(x: 0, y: 0, width: w, height: L.height)
    highlight.backgroundColor = row.sel == 2 ? th.selection : th.highlight
    if row.sel == 2 { highlight.alpha = 1 } else if highlight.layer.animationKeys() == nil { highlight.alpha = 0 }

    let isPill = row.kind != .msg
    // [2026-10-22 pilula-vazia] data/sistema SEM texto (evento de sistema oculto) = linha de 1 pt,
    // mas a cápsula (20×22, mín. do tg-style) era pintada mesmo assim e vazava por cima da
    // linha seguinte → "círculo branco" sobre o divisor "1 mensagem não lida". = Android (só pinta c/ texto).
    pillBg.isHidden = !isPill || (row.kind != .unread && row.text.isEmpty)
    pillText.isHidden = !isPill
    slide.isHidden = isPill
    selIcon.isHidden = isPill || row.sel == 0
    // [2026-10-19 tg-style] cápsula (data/sistema) · [perf-scroll] fosca pré-composta, sem desfoque
    let blurPill = isPill && s.ts && row.kind != .unread && !L.pillFrame.isEmpty
    if isPill {
      pillText.layout = L.pillText
      pillText.frame = L.pillTextFrame
      pillBg.frame = L.pillFrame
      switch row.kind {
      case .unread:
        pillBg.backgroundColor = th.unreadBg
        pillBg.layer.cornerRadius = 0
      default:
        pillBg.backgroundColor = blurPill ? CMLLook.frostedPill(tint: th.pillBg, wall: th.wall) : th.pillBg
        pillBg.layer.cornerRadius = blurPill ? L.pillFrame.height / 2 : min(8, L.pillFrame.height / 2) // [2026-10-17 wa-pills]
        if #available(iOS 13.0, *) { pillBg.layer.cornerCurve = .continuous }
      }
      if blocks.info != nil { blocks.apply(nil, key: key, placeholder: nil) }
      return
    }

    // bounds+center (seguro com transform ativo: swipe / animação de seleção)
    slide.bounds = CGRect(x: 0, y: 0, width: w, height: L.height)
    slide.center = CGPoint(x: w / 2, y: L.height / 2)
    // seleção
    if row.sel > 0 {
      selIcon.kind = row.sel == 2 ? .selectOn : .select
      selIcon.color = th.accent
      selIcon.ring = th.otherMeta
      selIcon.frame = L.selCircle
    }
    replyIcon.frame = CGRect(x: L.replyIconX, y: L.bubbleFrame.midY - 15, width: 30, height: 30)
    replyIcon.color = th.pillText
    replyIcon.disc = th.pillBg

    // balão
    if L.showBubble, let p = L.bubblePath {
      bubble.isHidden = false
      bubble.path = p
      bubble.fillColor = (row.own ? th.ownBubble : (row.bubbleBg.map { CMLTheme.uiColor($0) } ?? th.otherBubble)).cgColor
      applyGrafite(row: row, theme: th, path: p)
    } else {
      bubble.isHidden = true
      bubble.path = nil
      applyGrafite(row: nil, theme: th, path: nil)
    }
    let o = L.bubbleFrame.origin

    func place(_ v: UIView, _ r: CGRect, _ show: Bool) {
      v.isHidden = !show
      if show { v.frame = r.offsetBy(dx: o.x, dy: o.y) }
    }

    nameView.layout = L.name
    place(nameView, L.nameFrame, L.name != nil)
    fwdView.layout = L.fwd
    place(fwdView, L.fwdFrame, L.fwd != nil)
    // [2026-10-17 fwd-label] seta à esquerda do rótulo (espaço reservado no layout)
    if L.fwd != nil {
      let iw = CMLLayoutBuilder.fwdIconW(row)
      fwdIcon.kind = row.forwardedMany ? .forwardMany : .forward
      fwdIcon.color = row.own ? th.ownMeta : th.otherMeta
      let h: CGFloat = 12
      place(fwdIcon, CGRect(x: L.fwdFrame.minX - iw, y: L.fwdFrame.midY - h / 2, width: iw - 4, height: h), true)
    } else {
      fwdIcon.isHidden = true
    }

    // citação
    if let rp = row.reply, L.replyName != nil {
      reply.apply(name: L.replyName, text: L.replyText, barColor: CMLTheme.uiColor(rp.color), bg: row.own ? th.ownQuote : th.otherQuote, hasThumb: L.replyThumb)
      reply.layer.cornerRadius = s.ts ? 6 : 8 // [tg-style] = cantos do cartão de link
      place(reply, L.replyFrame, true)
      if L.replyThumb {
        let tok = rp.thumb
        reply.thumbToken = tok
        if let img = CMLImageLoader.shared.cached(tok, maxPixel: 120) { reply.thumb.image = img }
        else {
          reply.thumb.image = nil
          CMLImageLoader.shared.load(tok, maxPixel: 120) { [weak self] img in
            guard let self = self, self.reply.thumbToken == tok else { return }
            self.reply.thumb.image = img
          }
        }
      }
    } else {
      reply.isHidden = true
    }

    // mídia única
    let scale = UIScreen.main.scale
    if let md = row.media, !L.mediaFrame.isEmpty {
      place(media, L.mediaFrame, true)
      applyCorners(media, L.mediaCorners, L.mediaRadius)
      // [2026-10-18 media-edge] contorno de 1 px (dentro do recorte) só quando a
      // mídia fica rente ao fundo (sem bolha atrás) e não é figurinha.
      if !L.showBubble && md.kind != "sticker" {
        var wr: CGFloat = 1, wg: CGFloat = 1, wb: CGFloat = 1, wa: CGFloat = 1
        if !th.wall.getRed(&wr, green: &wg, blue: &wb, alpha: &wa) { th.wall.getWhite(&wr, alpha: &wa); wg = wr; wb = wr }
        let darkWall = (0.299 * wr + 0.587 * wg + 0.114 * wb) < 0.5
        CATransaction.begin(); CATransaction.setDisableActions(true)
        // [perf-scroll] view irmã por cima da mídia: traço de 1 px centrado ½ px
        // para dentro = mesmos pixels da metade interna do traço de 2 px recortado.
        let mb = CGRect(origin: .zero, size: media.bounds.size)
        let hw = 0.5 / max(1, scale)
        let ib = mb.insetBy(dx: hw, dy: hw)
        let lastSize = mediaEdgeHost.bounds.size
        mediaEdgeHost.frame = media.frame
        if lastSize != mb.size || mediaEdgeCorners != L.mediaCorners || mediaEdgeRadius != L.mediaRadius || mediaEdge.path == nil {
          mediaEdge.frame = mb
          mediaEdge.path = L.mediaCorners.count == 4
            ? CMLLayoutBuilder.roundedPath(ib, L.mediaCorners.map { max(0, $0 - hw) })
            : UIBezierPath(roundedRect: ib, cornerRadius: max(0, L.mediaRadius - hw)).cgPath
          mediaEdgeCorners = L.mediaCorners
          mediaEdgeRadius = L.mediaRadius
        }
        mediaEdge.lineWidth = 1 / max(1, scale)
        mediaEdge.strokeColor = (darkWall ? UIColor(white: 1, alpha: 0.12) : UIColor(white: 0, alpha: 0.10)).cgColor
        mediaEdgeHost.isHidden = false
        CATransaction.commit()
      } else {
        mediaEdgeHost.isHidden = true
      }
      media.contentMode = md.kind == "sticker" ? .scaleAspectFit : .scaleAspectFill
      media.backgroundColor = md.kind == "sticker" ? .clear : (row.own ? th.ownQuote : th.otherQuote)
      let px = max(L.mediaFrame.width, L.mediaFrame.height) * scale
      setImage(media, slot: -1, uri: effectiveURI(md), thumb: md.thumb, maxPixel: px, animated: md.kind == "gif" || md.kind == "sticker", vf: md.kind == "video" ? md.vf : "")
      let isVideo = md.kind == "video"
      let showPlay = isVideo && md.up == nil
      playBadge.isHidden = !showPlay
      if showPlay {
        let s: CGFloat = 46
        playBadge.frame = CGRect(x: L.mediaFrame.midX - s / 2, y: L.mediaFrame.midY - s / 2, width: s, height: s).offsetBy(dx: o.x, dy: o.y)
      }
      if (isVideo || md.kind == "gif" || md.kind == "image") && !md.dur.isEmpty { // [2026-10-16 gif] pílula "GIF" · [2026-10-19 media-quality] "HD" em foto
        durLabel.isHidden = false
        let dl = CMLLayoutBuilder.line(md.dur, font: s.meta, color: .white, maxWidth: 80)
        durLabel.layout = dl
        if s.ts {
          // [2026-10-19 tg-style] duração em pílula (mesma linha/altura da hora) ·
          // [perf-scroll] fundo chapado translúcido (era UIVisualEffectView)
          let ph: CGFloat = 18
          let pr = CGRect(x: L.mediaFrame.minX + 5, y: L.mediaFrame.maxY - ph - 5, width: ceil(dl.size.width) + 12, height: ph).offsetBy(dx: o.x, dy: o.y)
          let pv = ensureDurPill()
          pv.isHidden = false
          pv.frame = pr
          pv.layer.cornerRadius = ph / 2
          durLabel.glow = 0
          durLabel.frame = CGRect(x: pr.minX + 6, y: pr.minY + floor((ph - dl.size.height) / 2), width: dl.size.width + 1, height: dl.size.height)
        } else {
          durPill?.isHidden = true
          // [2026-10-19 perf-scroll] sombra do texto pré-renderizada (era layer.shadow sem shadowPath)
          durLabel.glow = 4
          durLabel.frame = durLabel.glowFrame(CGRect(x: L.mediaFrame.minX + 8, y: L.mediaFrame.maxY - dl.size.height - 7, width: dl.size.width + 1, height: dl.size.height).offsetBy(dx: o.x, dy: o.y))
        }
      } else {
        durLabel.isHidden = true
        durPill?.isHidden = true
      }
      mediaDim.frame = media.frame
      applyCorners(mediaDim, L.mediaCorners, L.mediaRadius)
    } else {
      media.isHidden = true
      media.image = nil
      mediaToken = ""
      _ = trackVF(-1, "")
      playBadge.isHidden = true
      durLabel.isHidden = true
      durPill?.isHidden = true
      mediaDim.isHidden = true
      mediaEdgeHost.isHidden = true
    }

    // álbum
    if !row.album.isEmpty && !L.albumFrames.isEmpty {
      if albumTokens.count != 4 { albumTokens = ["", "", "", ""] }
      for i in 0..<4 {
        let iv = albumViews[i]
        if i < L.albumFrames.count && i < row.album.count {
          let md = row.album[i]
          place(iv, L.albumFrames[i], true)
          applyCorners(iv, i < L.albumCorners.count ? L.albumCorners[i] : [], 4)
          iv.backgroundColor = row.own ? th.ownQuote : th.otherQuote
          let f = L.albumFrames[i]
          setImage(iv, slot: i, uri: effectiveURI(md), thumb: md.thumb, maxPixel: max(f.width, f.height) * scale, animated: false, vf: md.kind == "video" ? md.vf : "")
        } else {
          iv.isHidden = true
          iv.image = nil
          albumTokens[i] = ""
          _ = trackVF(i, "")
        }
      }
      if row.more > 0, let last = L.albumFrames.last {
        moreDim.isHidden = false
        moreDim.frame = last.offsetBy(dx: o.x, dy: o.y)
        applyCorners(moreDim, L.albumCorners.count == L.albumFrames.count ? (L.albumCorners.last ?? []) : [], 4)
        let ml = CMLLayoutBuilder.line("+\(row.more)", font: UIFont.systemFont(ofSize: 26, weight: .semibold), color: .white, maxWidth: 120)
        moreLabel.layout = ml
        moreLabel.isHidden = false
        moreLabel.frame = CGRect(x: last.midX - ml.size.width / 2, y: last.midY - ml.size.height / 2, width: ml.size.width + 1, height: ml.size.height).offsetBy(dx: o.x, dy: o.y)
      } else {
        moreDim.isHidden = true
        moreLabel.isHidden = true
      }
    } else {
      for iv in albumViews { iv.isHidden = true; iv.image = nil }
      albumTokens = []
      for i in 0..<4 { _ = trackVF(i, "") }
      moreDim.isHidden = true
      moreLabel.isHidden = true
    }

    // texto
    let spoilerBg: UIColor = L.showBubble ? (row.own ? th.ownBubble : (row.bubbleBg.map { CMLTheme.uiColor($0) } ?? th.otherBubble)) : th.wall
    let sp = CMLSpoilerStyle(bg: spoilerBg, revealed: extra.revealed)
    textView.spoiler = sp
    textView.layout = L.text
    place(textView, L.textFrame, L.text != nil)
    // [2026-10-15 native-effects] emoji grande anima ao aparecer (1× por mensagem)
    if prevKey != key { jumboPending = row.kind == .msg && row.jumbo > 0 && !row.deleted }

    // [fase 2] blocos (cartões / pre / post)
    if let B = L.blocks, !B.isEmpty {
      blocks.isHidden = false
      blocks.frame = CGRect(origin: o, size: L.bubbleFrame.size)
      blocks.spoiler = sp
      blocks.apply(B, key: key, placeholder: row.own ? th.ownQuote : th.otherQuote)
    } else if blocks.info != nil {
      blocks.apply(nil, key: key, placeholder: nil)
      blocks.isHidden = true
    } else {
      blocks.isHidden = true
    }
    deletedIcon.isHidden = !L.deletedIcon
    if L.deletedIcon {
      deletedIcon.color = row.own ? th.ownMeta : th.otherMeta
      deletedIcon.frame = CGRect(x: L.textFrame.minX - 19, y: L.textFrame.minY + floor((s.lineHeight - 15) / 2), width: 15, height: 15).offsetBy(dx: o.x, dy: o.y)
    }

    // áudio
    if let au = row.audio, !L.audioFrame.isEmpty {
      place(audio, L.audioFrame, true)
      audio.tint = row.own ? th.ownText : th.otherText
      audio.dim = (row.own ? th.ownText : th.otherText).withAlphaComponent(0.32)
      // [2026-10-19 tg-style] botão cheio na tinta, glifo na cor da bolha (Telegram)
      let bubbleC: UIColor = row.own ? th.ownBubble : (row.bubbleBg.map { CMLTheme.uiColor($0) } ?? th.otherBubble)
      audio.solidGlyph = s.ts ? bubbleC : nil
      audio.wave = au.wave
      audio.unplayedDot = (!row.own && au.voice && !au.played) ? th.read : nil
      applyAudio(audioState, style: s)
    } else {
      audio.isHidden = true
    }

    // arquivo
    if row.file != nil, !L.fileFrame.isEmpty {
      place(fileView, L.fileFrame, true)
      fileView.nameL = L.fileName
      fileView.sizeL = L.fileSize
      fileView.extL = L.fileExt
      fileView.iconColor = row.own ? th.ownText.withAlphaComponent(0.22) : th.accent.withAlphaComponent(0.85)
    } else {
      fileView.isHidden = true
    }

    // [native-media-dl] anéis (enviar/baixar) por cima de mídia/álbum/áudio/arquivo
    applyTransfers(animated: prevKey == key && window != nil)

    // meta
    meta.meta = L.meta
    meta.pill = L.meta.onMedia
    // [perf-scroll] tg-style sem desfoque atrás → véu um pouco mais denso (≈ material
    // ultra-fino escuro + 0,26 de antes sobre foto média)
    meta.pillAlpha = s.ts ? 0.36 : 0.42
    meta.readColor = th.read
    meta.failedColor = th.failed
    place(meta, L.metaFrame, !L.metaFrame.isEmpty)
    // [motion-conv] status avançou na MESMA linha visível → transição animada
    if prevKey != key {
      meta.cancelStatusAnim()
    } else if let ps = prevStatus, let ns = L.meta.status, ns > ps, ps >= 0,
              CMLMotion.ticks, !CMLMotion.reduce, window != nil, !meta.isHidden {
      meta.animateStatus(from: ps)
    }
    // [2026-10-18 tg-list, apiVersion 11] relógio do pendente gira após ~300 ms
    if row.kind == .msg && L.meta.status == 0 && !meta.isHidden && CMLMotion.clock && !CMLMotion.reduce {
      meta.setClockSpin(true, key: key)
    } else {
      meta.setClockSpin(false, key: key)
      if let st = L.meta.status, st != 0 { CMLMetaView.clearPending(key) }
    }

    // reações (coordenadas da linha, não do balão)
    if !L.reactChips.isEmpty {
      reacts.isHidden = false
      // bounds+center (não frame): o "pop" do menu nativo anima o transform
      reacts.bounds = CGRect(origin: .zero, size: L.reactsFrame.size)
      reacts.center = CGPoint(x: L.reactsFrame.midX, y: L.reactsFrame.midY)
      reacts.bg = th.reactBg
      reacts.border = th.reactBorder
      reacts.layer.shadowOpacity = s.ts ? 0 : 0.08 // [tg-style] chips chapados
      // [2026-10-19 perf-scroll] shadowPath = união dos chips (sem ele o CA mede o
      // alfa do conteúdo desenhado → passe offscreen por quadro na rolagem)
      if !s.ts { reacts.layer.shadowPath = CMLCell.chipsShadowPath(L.reactChips) } else { reacts.layer.shadowPath = nil }
      reacts.mineBg = th.selection.withAlphaComponent(0.9)
      reacts.mine = row.reacts.map { $0.mine }
      reacts.chips = L.reactChips
      // [motion-conv] reação NOVA de outra pessoa (a minha já pula pelo menu
      // nativo → checkPendingPop): emoji novo ou contagem subiu, "mine" igual.
      if prevKey == key && CMLMotion.react && window != nil, let gi = CMLCell.othersReacted(prevReacts, row.reacts) {
        DispatchQueue.main.async { [weak self] in
          guard let self = self, self.key == key else { return }
          self.popReactions()
          self.sparkReaction(gi)
        }
      }
    } else {
      reacts.isHidden = true
    }
  }

  // MARK: [2026-10-19 perf-scroll] pílula da duração (sem desfoque)

  private func ensureDurPill() -> UIView {
    if let v = durPill { return v }
    let v = UIView()
    v.isUserInteractionEnabled = false
    // ≈ material ultra-fino escuro + véu 0,26 de antes, sobre foto média
    v.backgroundColor = UIColor(white: 0, alpha: 0.38)
    if #available(iOS 13.0, *) { v.layer.cornerCurve = .continuous }
    v.isHidden = true
    slide.insertSubview(v, belowSubview: durLabel)
    durPill = v
    return v
  }

  /// [perf-scroll] caminho da sombra dos chips de reação (mesmo recorte do draw).
  static func chipsShadowPath(_ chips: [(CGRect, CTLine)]) -> CGPath {
    let p = CGMutablePath()
    for c in chips {
      let r = c.0.insetBy(dx: 0.75, dy: 0.75)
      p.addPath(UIBezierPath(roundedRect: r, cornerRadius: r.height / 2).cgPath)
    }
    return p
  }

  /// [motion-conv] Alguém (não eu) reagiu: emoji novo ou contagem maior, e o
  /// conjunto das MINHAS reações não mudou → índice do chip que cresceu.
  static func othersReacted(_ a: [CMLReact], _ b: [CMLReact]) -> Int? {
    if b.isEmpty { return nil }
    var oldCount: [String: Int] = [:]
    var oldMine = Set<String>()
    for r in a { oldCount[r.emoji] = r.count; if r.mine { oldMine.insert(r.emoji) } }
    var newMine = Set<String>()
    var grew: Int? = nil
    for (i, r) in b.enumerated() {
      if r.mine { newMine.insert(r.emoji) }
      if grew == nil && r.count > (oldCount[r.emoji] ?? 0) { grew = i }
    }
    return oldMine == newMine ? grew : nil
  }

  /// [motion-conv] 6 pontinhos saem do chip `i` em leque, encolhem e somem
  /// (= ReactionSparks do JS, ~380 ms). Camadas temporárias, sem layout.
  func sparkReaction(_ i: Int) {
    guard let L = layoutInfo, i >= 0, i < L.reactChips.count, !reacts.isHidden, !CMLMotion.reduce, window != nil else { return }
    let f = L.reactChips[i].0
    let c = CGPoint(x: L.reactsFrame.minX + f.midX, y: L.reactsFrame.minY + f.midY)
    let color = UIColor(white: 0.5, alpha: 0.75).cgColor
    let n = 6
    let dist: CGFloat = 18
    let sz: CGFloat = 4
    var dots: [CALayer] = []
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    CATransaction.setCompletionBlock { for d in dots { d.removeFromSuperlayer() } }
    for k in 0..<n {
      let ang = CGFloat.pi * 2 * CGFloat(k) / CGFloat(n) - CGFloat.pi / 2 + 0.3
      let d = CALayer()
      d.bounds = CGRect(x: 0, y: 0, width: sz, height: sz)
      d.cornerRadius = sz / 2
      d.backgroundColor = color
      d.position = c
      d.opacity = 0
      slide.layer.addSublayer(d)
      let to = CGPoint(x: c.x + cos(ang) * dist, y: c.y + sin(ang) * dist)
      let pos = CABasicAnimation(keyPath: "position")
      pos.fromValue = NSValue(cgPoint: c)
      pos.toValue = NSValue(cgPoint: to)
      pos.timingFunction = CAMediaTimingFunction(name: .easeOut)
      let op = CAKeyframeAnimation(keyPath: "opacity")
      op.values = [0, 0.9, 0]
      op.keyTimes = [0, 0.15, 1]
      let sc = CAKeyframeAnimation(keyPath: "transform.scale")
      sc.values = [0.6, 1, 0.2]
      sc.keyTimes = [0, 0.3, 1]
      let g = CAAnimationGroup()
      g.animations = [pos, op, sc]
      g.duration = 0.38
      d.add(g, forKey: "spark")
      dots.append(d)
    }
    CATransaction.commit()
  }

  func applyAudio(_ st: CMLAudioState?, style s: CMLStyle) {
    guard let row = row, let au = row.audio else { return }
    let active = st != nil && st!.id == row.id
    audio.playing = active && st!.playing
    audio.loading = active && st!.loading
    var dur = Double(au.duration)
    if active, let d = st?.durMs, d > 0 { dur = d / 1000 }
    var shown = dur
    // [motion-conv] progresso suave (extrapolado entre pulsos) com `motion.a`
    audio.smooth = CMLMotion.audio
    if active, let p = st?.posMs, p > 0 {
      shown = p / 1000
      audio.setPlayback(posMs: p, durMs: dur * 1000, playing: audio.playing)
    } else {
      audio.resetPlayback()
    }
    let sec = max(0, Int(shown.rounded()))
    let txt = String(format: "%d:%02d", sec / 60, sec % 60)
    audio.durText = CMLLayoutBuilder.line(txt, font: s.meta, color: row.own ? s.theme.ownMeta : s.theme.otherMeta, maxWidth: 80)
    // [voz-wa] pílula 1×/1,5×/2× (só na nota tocando/pausada, como o WhatsApp)
    let rl = active ? (st?.rateLabel ?? "") : ""
    if rl.isEmpty {
      if audio.rateText != nil { audio.rateText = nil }
    } else {
      audio.rateText = CMLLayoutBuilder.line(rl, font: UIFont.systemFont(ofSize: 12 * s.scale, weight: .bold), color: row.own ? s.theme.ownText : s.theme.otherText, maxWidth: 64)
    }
  }

  /// [2026-10-18 vthumb] registra o 1º frame pedido p/ o slot; cancela o anterior. true = precisa pedir.
  private func trackVF(_ slot: Int, _ vf: String) -> Bool {
    let prev = vfReq[slot] ?? ""
    if prev == vf { return false }
    if !prev.isEmpty { CMLVideoFrameLoader.shared.cancel(prev) }
    if vf.isEmpty {
      vfReq.removeValue(forKey: slot)
    } else {
      vfReq[slot] = vf
    }
    return !vf.isEmpty
  }

  private func setImage(_ iv: UIImageView, slot: Int, uri: String, thumb: String, maxPixel: CGFloat, animated: Bool, vf: String = "") {
    // [2026-10-18 vthumb] vídeo sem pôster (uri e miniatura vazias) → 1º frame extraído no aparelho
    let vfUse = (uri.isEmpty && thumb.isEmpty) ? vf : ""
    let tok = uri + "#" + thumb + (vfUse.isEmpty ? "" : "#vf:" + vfUse)
    let cur = slot < 0 ? mediaToken : (slot < albumTokens.count ? albumTokens[slot] : "")
    // [2026-10-18 lqip] mesmo token mas só a LQIP na tela (pôster falhou) → tenta de novo
    if cur == tok && iv.image != nil && (uri.isEmpty || fullTok[slot] == tok) { return }
    let keepLQIP = cur == tok && iv.image != nil
    if cur != tok {
      fullTok.removeValue(forKey: slot)
      retryN.removeValue(forKey: slot)
    }
    if slot < 0 { mediaToken = tok } else if slot < albumTokens.count { albumTokens[slot] = tok }
    let loader = CMLImageLoader.shared
    if let img = loader.cached(uri, maxPixel: maxPixel, animated: animated) { iv.image = img; fullTok[slot] = tok; return }
    if !keepLQIP {
      if !thumb.isEmpty, let t = loader.cachedBlurred(thumb) { iv.image = t } else { iv.image = nil }
    }
    let myTok = tok
    if !thumb.isEmpty && iv.image == nil {
      loader.loadBlurred(thumb) { [weak iv] img in
        guard let iv = iv, iv.image == nil, let img = img else { return }
        if self.currentToken(for: iv) == myTok { iv.image = img }
      }
    }
    if uri.isEmpty {
      if vfUse.isEmpty {
        _ = trackVF(slot, "")
        return
      }
      let vfl = CMLVideoFrameLoader.shared
      if let frame = vfl.cached(vfUse) {
        _ = trackVF(slot, "")
        iv.image = frame
        return
      }
      if trackVF(slot, vfUse) {
        vfl.load(vfUse, maxPixel: maxPixel) { [weak self, weak iv] img in
          guard let self = self else { return }
          if self.vfReq[slot] == vfUse { self.vfReq.removeValue(forKey: slot) }
          guard let iv = iv, let img = img else { return }
          guard self.currentToken(for: iv) == myTok else { return }
          UIView.transition(with: iv, duration: 0.22, options: [.transitionCrossDissolve, .allowUserInteraction], animations: { iv.image = img })
        }
      }
      return
    }
    _ = trackVF(slot, "")
    loader.load(uri, maxPixel: maxPixel, animated: animated) { [weak self, weak iv] img in
      guard let self = self, let iv = iv else { return }
      guard self.currentToken(for: iv) == myTok else { return }
      guard let img = img else {
        self.scheduleRetry(iv, slot: slot, tok: myTok, uri: uri, thumb: thumb, maxPixel: maxPixel, animated: animated)
        return
      }
      self.fullTok[slot] = myTok
      if iv.image != nil {
        UIView.transition(with: iv, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction], animations: { iv.image = img })
      } else {
        iv.image = img
      }
    }
  }

  /// [2026-10-18 lqip] pôster falhou (404/rede): tenta de novo em 2 s, 6 s, 15 s
  /// enquanto a célula ainda mostra a mesma linha (token igual).
  private func scheduleRetry(_ iv: UIImageView, slot: Int, tok: String, uri: String, thumb: String, maxPixel: CGFloat, animated: Bool) {
    if retryArmed.contains(slot) { return }
    let n = retryN[slot] ?? 0
    let delays: [Double] = [2, 6, 15]
    guard n < delays.count else { return }
    retryN[slot] = n + 1
    retryArmed.insert(slot)
    DispatchQueue.main.asyncAfter(deadline: .now() + delays[n]) { [weak self, weak iv] in
      guard let self = self else { return }
      self.retryArmed.remove(slot)
      guard let iv = iv, !iv.isHidden else { return }
      guard self.currentToken(for: iv) == tok, self.fullTok[slot] != tok else { return }
      self.setImage(iv, slot: slot, uri: uri, thumb: thumb, maxPixel: maxPixel, animated: animated)
    }
  }

  private func currentToken(for iv: UIImageView) -> String {
    if iv === media { return mediaToken }
    if let i = albumViews.firstIndex(where: { $0 === iv }), i < albumTokens.count { return albumTokens[i] }
    return ""
  }

  // MARK: hit test (ponto em coordenadas do contentView)

  /// [2026-10-20 grafite, apiVersion 14] gradiente + reflexo + sombra (shadowPath
  /// explícito → sem passe offscreen). Sem as chaves no tema = nada muda.
  private func applyGrafite(row: CMLRow?, theme th: CMLTheme, path p: CGPath?) {
    let ownG: [UIColor]? = (row?.own == true && row?.bubbleBg == nil) ? th.ownGradient : nil
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if let cols = ownG, let path = p {
      let box = path.boundingBoxOfPath
      let g: CAGradientLayer
      if let e = ownGrad { g = e } else {
        g = CAGradientLayer()
        let m = CAShapeLayer()
        g.mask = m
        ownGradMask = m
        slide.layer.insertSublayer(g, above: bubble)
        ownGrad = g
      }
      g.isHidden = false
      g.frame = box
      g.colors = cols.map { $0.cgColor }
      g.locations = th.ownGradientStops
      // ~165° (CSS): de cima (levemente à esquerda) para baixo (levemente à direita)
      g.startPoint = CGPoint(x: 0.37, y: 0)
      g.endPoint = CGPoint(x: 0.63, y: 1)
      var t = CGAffineTransform(translationX: -box.origin.x, y: -box.origin.y)
      ownGradMask?.path = path.copy(using: &t)
      // reflexo interno de 1 px no topo (linha reta entre os cantos)
      let sh: CAShapeLayer
      if let e = ownShine { sh = e } else {
        sh = CAShapeLayer()
        sh.fillColor = UIColor.clear.cgColor
        sh.strokeColor = UIColor(white: 1, alpha: 0.12).cgColor
        sh.lineWidth = 1
        sh.lineCap = .round
        g.addSublayer(sh)
        ownShine = sh
      }
      let inset: CGFloat = min(18, box.height / 2)
      let line = CGMutablePath()
      if box.width > inset * 2 + 2 {
        line.move(to: CGPoint(x: inset, y: 0.5))
        line.addLine(to: CGPoint(x: box.width - inset, y: 0.5))
      }
      sh.frame = CGRect(origin: .zero, size: box.size)
      sh.path = line
      bubble.shadowPath = path
      bubble.shadowColor = UIColor.black.cgColor
      bubble.shadowOpacity = 0.12
      bubble.shadowRadius = 7
      bubble.shadowOffset = CGSize(width: 0, height: 4)
    } else {
      ownGrad?.isHidden = true
      if row != nil && row?.own == false && th.otherShadow, let path = p {
        bubble.shadowPath = path
        bubble.shadowColor = UIColor.black.cgColor
        bubble.shadowOpacity = 0.06
        bubble.shadowRadius = 5
        bubble.shadowOffset = CGSize(width: 0, height: 2)
      } else if bubble.shadowPath != nil || bubble.shadowOpacity != 0 {
        bubble.shadowPath = nil
        bubble.shadowOpacity = 0
      }
    }
    CATransaction.commit()
  }

  enum Part { case bubble, media(Int), reply, link(String, Int), audio, audioRate, file, reaction(Int), action(String, CGRect, CGFloat), retry, vnote(Int), spoiler, xfer(Int), none }

  /// [native-media-dl] slots de transferência: -1 mídia única, 0..3 álbum
  static let xferAudio = 100
  static let xferFile = 101

  func part(at pContent: CGPoint) -> Part {
    guard let L = layoutInfo, let row = row else { return .none }
    if row.kind != .msg { return .bubble }
    if !failIcon.isHidden && failIcon.frame.insetBy(dx: -10, dy: -10).contains(pContent) { return .retry }
    let slideX = slide.center.x - slide.bounds.width / 2
    let p = CGPoint(x: pContent.x - slideX - slide.transform.tx, y: pContent.y)
    if !reacts.isHidden && L.reactsFrame.insetBy(dx: -4, dy: -4).contains(p) {
      let lp = CGPoint(x: p.x - L.reactsFrame.minX, y: p.y - L.reactsFrame.minY)
      for (i, c) in L.reactChips.enumerated() where c.0.insetBy(dx: -2, dy: -4).contains(lp) { return .reaction(i) }
      return .reaction(0)
    }
    let o = L.bubbleFrame.origin
    let bp = CGPoint(x: p.x - o.x, y: p.y - o.y)
    if let B = L.blocks, !B.isEmpty, let h = B.hit(bp, spoilerRevealed: revealed) {
      switch h {
      case .link(let u): return .link(u, 0)
      case .spoiler: return .spoiler
      case .vnote(let i): return .vnote(i)
      case .action(let a, let r, let rad): return .action(a, r, rad)
      }
    }
    if let xs = xferHit(bp, L) { return .xfer(xs) }
    if !L.albumFrames.isEmpty {
      for (i, f) in L.albumFrames.enumerated() where f.contains(bp) { return .media(i) }
    }
    if !L.mediaFrame.isEmpty && L.mediaFrame.contains(bp) { return .media(0) }
    if !L.replyFrame.isEmpty && L.replyFrame.contains(bp) { return .reply }
    if !L.audioFrame.isEmpty && !audio.isHidden, let pr = audio.ratePillRect, pr.offsetBy(dx: L.audioFrame.minX, dy: L.audioFrame.minY).insetBy(dx: -8, dy: -8).contains(bp) { return .audioRate }
    if !L.audioFrame.isEmpty && L.audioFrame.insetBy(dx: -4, dy: -6).contains(bp) { return .audio }
    if !L.fileFrame.isEmpty && L.fileFrame.contains(bp) { return .file }
    if let t = L.text, !L.textFrame.isEmpty {
      let tp = CGPoint(x: bp.x - L.textFrame.minX, y: bp.y - L.textFrame.minY)
      if !revealed && t.hasExtras && t.spoiler(at: tp) { return .spoiler }
      if let hit = t.link(at: tp) { return .link(hit.0, hit.1) }
    }
    let bubbleHit = L.bubbleFrame.insetBy(dx: -6, dy: -4)
    if bubbleHit.contains(p) { return .bubble }
    return .none
  }

  // MARK: animações

  /// [fase 2] "pular para mensagem": destaque pulsando 2×.
  func flash() {
    highlight.layer.removeAllAnimations()
    highlight.alpha = 0
    let endAlpha: CGFloat = row?.sel == 2 ? 1 : 0
    UIView.animateKeyframes(withDuration: 1.6, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.11) { self.highlight.alpha = 1 }
      UIView.addKeyframe(withRelativeStartTime: 0.24, relativeDuration: 0.16) { self.highlight.alpha = 0.2 }
      UIView.addKeyframe(withRelativeStartTime: 0.40, relativeDuration: 0.11) { self.highlight.alpha = 1 }
      UIView.addKeyframe(withRelativeStartTime: 0.66, relativeDuration: 0.34) { self.highlight.alpha = endAlpha }
    })
  }

  /// [fase 2] Revela spoilers desta linha (fade).
  func revealSpoilers() {
    revealed = true
    let views: [UIView] = [textView, blocks]
    for v in views where !v.isHidden {
      UIView.transition(with: v, duration: 0.2, options: [.transitionCrossDissolve, .allowUserInteraction], animations: {
        if let tv = v as? CMLTextView, let sp = tv.spoiler { tv.spoiler = CMLSpoilerStyle(bg: sp.bg, revealed: true) }
        if let bv = v as? CMLBlocksView, let sp = bv.spoiler { bv.spoiler = CMLSpoilerStyle(bg: sp.bg, revealed: true) }
      })
    }
  }

  /// [fase 2] Esconde a linha enquanto o overlay do menu (JS) mostra o snapshot.
  func setLifted(_ on: Bool, animated: Bool) {
    lifted = on
    if on {
      contentView.layer.removeAllAnimations()
      contentView.alpha = 0
    } else if animated {
      UIView.animate(withDuration: 0.15, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: { self.contentView.alpha = 1 })
    } else {
      contentView.alpha = 1
    }
  }

  /// [fase 2] "Levantar" curtinho (1.03 por 110 ms) em torno do centro do balão.
  func liftPulse() {
    guard let L = layoutInfo, !UIAccessibility.isReduceMotionEnabled else { return }
    let c = CGPoint(x: L.bubbleFrame.midX - slide.bounds.midX, y: L.bubbleFrame.midY - slide.bounds.midY)
    let t = CGAffineTransform(translationX: c.x, y: c.y).scaledBy(x: 1.03, y: 1.03).translatedBy(x: -c.x, y: -c.y)
    UIView.animate(withDuration: 0.11, delay: 0, options: [.allowUserInteraction, .curveEaseOut], animations: {
      self.slide.transform = t
    }, completion: { _ in
      UIView.animate(withDuration: 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.slide.transform = .identity
      })
    })
  }

  /// [2026-10-18 tg-look] Raio por canto [tl, tr, br, bl] via máscara; vazio = raio uniforme (antigo).
  private func applyCorners(_ v: UIView, _ c: [CGFloat], _ fallback: CGFloat) {
    let all: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMaxXMaxYCorner, .layerMinXMaxYCorner]
    if c.count == 4 {
      // [2026-10-19 perf-scroll] cantos "uniformes" (todos iguais, ou só 0 e um único
      // raio — o caso comum: foto sozinha, foto c/ legenda, 1ª do grupo) → cornerRadius
      // + maskedCorners (caminho rápido, sem passe offscreen). Máscara CAShapeLayer só
      // quando há 2 raios diferentes (meio de grupo / mosaico do álbum).
      let lim = min(v.bounds.width, v.bounds.height) / 2
      let cl = c.map { max(0, min($0, lim)) }
      var radius: CGFloat = 0
      var uniform = true
      for r in cl where r > 0.01 {
        if radius == 0 { radius = r } else if abs(r - radius) > 0.01 { uniform = false; break }
      }
      if uniform {
        if v.layer.mask != nil { v.layer.mask = nil }
        if radius > 0 {
          var m: CACornerMask = []
          if cl[0] > 0.01 { m.insert(.layerMinXMinYCorner) }
          if cl[1] > 0.01 { m.insert(.layerMaxXMinYCorner) }
          if cl[2] > 0.01 { m.insert(.layerMaxXMaxYCorner) }
          if cl[3] > 0.01 { m.insert(.layerMinXMaxYCorner) }
          v.layer.maskedCorners = m
          v.layer.cornerRadius = radius
        } else {
          v.layer.maskedCorners = all
          v.layer.cornerRadius = 0
        }
        return
      }
      v.layer.cornerRadius = 0
      v.layer.maskedCorners = all
      let m = (v.layer.mask as? CAShapeLayer) ?? CAShapeLayer()
      m.frame = v.bounds
      m.path = CMLLayoutBuilder.roundedPath(v.bounds, c)
      if v.layer.mask !== m { v.layer.mask = m }
    } else {
      if v.layer.mask != nil { v.layer.mask = nil }
      v.layer.maskedCorners = all
      v.layer.cornerRadius = fallback
    }
  }

  /// [native-ctxmenu] Retângulo ATUAL do balão na janela (p/ a volta do menu).
  func liftRectInWindow() -> CGRect? {
    guard let L = layoutInfo, let row = row, row.kind == .msg, window != nil else { return nil }
    let r = L.bubbleFrame.offsetBy(dx: slide.center.x - slide.bounds.width / 2, dy: slide.center.y - slide.bounds.height / 2)
    guard r.width > 1, r.height > 1 else { return nil }
    return contentView.convert(r, to: nil)
  }

  /// [hero] Miniatura `i` (foto/vídeo/tile do álbum) na janela + raio dos cantos.
  func mediaRectInWindow(_ i: Int) -> (CGRect, CGFloat)? {
    guard let L = layoutInfo, let row = row, row.kind == .msg, window != nil else { return nil }
    var f: CGRect
    var radius: CGFloat
    if !L.albumFrames.isEmpty {
      f = L.albumFrames[max(0, min(L.albumFrames.count - 1, i))]
      radius = 4
    } else if !L.mediaFrame.isEmpty {
      f = L.mediaFrame
      radius = L.mediaRadius
    } else {
      return nil
    }
    f = f.offsetBy(dx: L.bubbleFrame.minX + slide.center.x - slide.bounds.width / 2 + slide.transform.tx,
                   dy: L.bubbleFrame.minY + slide.center.y - slide.bounds.height / 2)
    guard f.width > 1, f.height > 1 else { return nil }
    return (contentView.convert(f, to: nil), radius)
  }

  /// [native-ctxmenu] Chip de reação novo: "pop" (0.3 → 1 com spring).
  func popReactions() {
    guard !reacts.isHidden, !UIAccessibility.isReduceMotionEnabled else { return }
    reacts.layer.removeAllAnimations()
    reacts.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
    reacts.alpha = 0.3
    UIView.animate(withDuration: 0.55, delay: 0, usingSpringWithDamping: 0.48, initialSpringVelocity: 0.9, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.reacts.transform = .identity
      self.reacts.alpha = 1
    })
  }

  /// [fase 2] Snapshot do BALÃO (sem reações) + retângulo em coordenadas de janela.
  func liftSnapshot() -> (UIImage, CGRect)? {
    guard let L = layoutInfo, let row = row, row.kind == .msg, window != nil else { return nil }
    let r = L.bubbleFrame.offsetBy(dx: slide.center.x - slide.bounds.width / 2, dy: slide.center.y - slide.bounds.height / 2)
    guard r.width > 1, r.height > 1 else { return nil }
    let reactsWasHidden = reacts.isHidden
    reacts.isHidden = true
    let savedT = slide.transform
    slide.transform = .identity
    let fmt = UIGraphicsImageRendererFormat.preferred()
    fmt.opaque = false
    fmt.scale = UIScreen.main.scale
    let img = UIGraphicsImageRenderer(size: r.size, format: fmt).image { c in
      c.cgContext.translateBy(x: -L.bubbleFrame.minX, y: -L.bubbleFrame.minY)
      // [2026-10-18 tg-look] render(in:) ignora máscaras → recorta pela forma da bolha/mídia
      if !L.mediaOuter.isEmpty {
        let clip: CGPath
        if let bp = L.bubblePath, L.showBubble {
          clip = bp
        } else {
          let mf = L.mediaFrame.offsetBy(dx: L.bubbleFrame.minX, dy: L.bubbleFrame.minY)
          clip = CMLLayoutBuilder.roundedPath(mf, L.mediaOuter)
        }
        c.cgContext.addPath(clip)
        c.cgContext.clip()
      }
      self.slide.layer.render(in: c.cgContext)
    }
    slide.transform = savedT
    reacts.isHidden = reactsWasHidden
    let win = contentView.convert(r, to: nil)
    return (img, win)
  }

  private func animateSelection(entering: Bool, leaving: Bool, own: Bool) {
    let g = CMLLayoutBuilder.selGutter
    if entering || leaving {
      if !own {
        slide.transform = CGAffineTransform(translationX: entering ? -g : g, y: 0)
      }
      if entering {
        selIcon.alpha = 0
        selIcon.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
      } else if let L = layoutInfo {
        // círculo some no lugar onde estava
        selIcon.isHidden = false
        selIcon.frame = CGRect(x: 10, y: L.bubbleFrame.midY - 11, width: 22, height: 22)
        selIcon.alpha = 1
      }
      UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .allowUserInteraction, .beginFromCurrentState], animations: {
        self.slide.transform = .identity
        if entering {
          self.selIcon.alpha = 1
          self.selIcon.transform = .identity
        } else {
          self.selIcon.alpha = 0
          self.selIcon.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        }
      }, completion: { _ in
        if leaving && (self.row?.sel ?? 0) == 0 {
          self.selIcon.isHidden = true
          self.selIcon.alpha = 1
          self.selIcon.transform = .identity
        }
      })
    } else {
      // marcar/desmarcar
      selIcon.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
      UIView.animate(withDuration: 0.2, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
        self.selIcon.transform = .identity
      })
    }
  }

  /// [reply-v2] "Estalo" do ícone ao cruzar o limiar: escala ADITIVA (não briga
  /// com o transform que o setSwipe reescreve a cada quadro do arrasto).
  func popReplyIcon() {
    if UIAccessibility.isReduceMotionEnabled { return }
    let k = CAKeyframeAnimation(keyPath: "transform.scale")
    k.isAdditive = true
    k.values = [0, 0.32, -0.06, 0]
    k.keyTimes = [0, 0.4, 0.75, 1]
    k.duration = 0.26
    k.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeOut)]
    replyIcon.layer.add(k, forKey: "replyPop")
  }

  func setSwipe(_ x: CGFloat, threshold: CGFloat) {
    slide.transform = CGAffineTransform(translationX: x, y: 0)
    let a = min(1, abs(x) / threshold)
    replyIcon.alpha = a
    let s = 0.6 + 0.4 * a
    replyIcon.transform = CGAffineTransform(scaleX: s, y: s)
    guard let L = layoutInfo, let row = row else { return }
    // ícone acompanha o lado de onde o balão saiu
    if x > 0 {
      replyIcon.center.x = (row.own ? L.bubbleFrame.minX : L.bubbleFrame.minX) + min(x, threshold) / 2 - 4
    } else {
      replyIcon.center.x = L.bubbleFrame.maxX + max(x, -threshold) / 2 + 4
    }
  }
}

struct CMLCellExtra {
  var revealed = false
  var lifted = false
}

struct CMLAudioState {
  var id: String
  var playing: Bool
  var loading: Bool
  var posMs: Double?
  var durMs: Double?
  /// [2026-10-17 voz-wa, apiVersion 8] rótulo da velocidade ("1×", "1,5×"); vazio = sem pílula
  var rateLabel: String = ""
}


// MARK: - [2026-10-15 native-media-dl] anel de transferência (baixar/enviar)

extension CMLCell {
  /// Estado de um slot: modo do anel + se a mídia já está local.
  private func xferState(_ dl: CMLMediaDL?, up: Int?, sizeText: Bool) -> (CMLTransferRing.Mode, Bool, CMLXfer?) {
    if let u = up {
      let m: CMLTransferRing.Mode = u < 0 ? .spin : .progress(Double(max(0, min(100, u))) / 100)
      return (m, true, nil)
    }
    guard let d = dl else { return (.hidden, true, nil) }
    let x = CMLTransfers.shared.probe(d)
    switch x.state {
    case .done: return (.hidden, true, x)
    case .queued: return (.spin, false, x)
    case .running:
      let m: CMLTransferRing.Mode = x.total > 0 ? .progress(x.fraction) : .spin
      return (m, false, x)
    default:
      if d.js && x.state == .none { return (.spin, false, x) } // o JS já está baixando
      let sz = sizeText ? CMLTransfers.formatBytes(d.size > 0 ? d.size : x.total) : ""
      return (.download(sz), false, x)
    }
  }

  /// URI a desenhar: foto/GIF com `dl` só aparece (nítida) depois de baixada —
  /// antes fica a miniatura borrada + anel. Vídeo: `uri` já é o pôster.
  func effectiveURI(_ md: CMLMedia) -> String {
    guard let d = md.dl, md.up == nil, md.kind == "image" || md.kind == "gif" else { return md.uri }
    let x = CMLTransfers.shared.probe(d)
    if x.state == .done, let l = x.local { return l }
    return ""
  }

  /// Atualiza só os anéis (e troca a miniatura pela foto quando termina).
  func applyTransfers(animated: Bool) {
    guard let row = row, let L = layoutInfo, row.kind == .msg else { return }
    var keys = Set<String>()
    let o = L.bubbleFrame.origin
    let scale = UIScreen.main.scale
    // mídia única
    if let md = row.media, !L.mediaFrame.isEmpty, md.kind != "sticker" {
      if let d = md.dl { keys.insert(d.key) }
      let (mode, done, x) = xferState(md.dl, up: md.up, sizeText: true)
      let wasShown = !xRing.isHidden
      place(ring: xRing, mode: mode, in: L.mediaFrame.offsetBy(dx: o.x, dy: o.y), animated: animated, done: done)
      let isVideo = md.kind == "video"
      playBadge.isHidden = !(isVideo && md.up == nil && done)
      mediaDim.isHidden = done || md.dl == nil
      if done, x != nil, md.kind == "image" || md.kind == "gif" {
        // terminou agora → foto nítida com cross-fade sobre a miniatura
        let u = effectiveURI(md)
        if !u.isEmpty && !mediaToken.hasPrefix(u + "#") {
          let px = max(L.mediaFrame.width, L.mediaFrame.height) * scale
          setImage(media, slot: -1, uri: u, thumb: md.thumb, maxPixel: px, animated: md.kind == "gif")
        }
      }
      if animated && wasShown && done && !playBadge.isHidden {
        playBadge.alpha = 0
        UIView.animate(withDuration: 0.25, delay: 0.2, options: [.allowUserInteraction], animations: { self.playBadge.alpha = 1 })
      }
    } else {
      xRing.reset()
      mediaDim.isHidden = true
    }
    // álbum
    for i in 0..<albumRings.count {
      let r = albumRings[i]
      guard i < row.album.count, i < L.albumFrames.count, !L.albumFrames.isEmpty else { r.reset(); continue }
      let md = row.album[i]
      if let d = md.dl { keys.insert(d.key) }
      let (mode, done, x) = xferState(md.dl, up: md.up, sizeText: false)
      place(ring: r, mode: mode, in: L.albumFrames[i].offsetBy(dx: o.x, dy: o.y), animated: animated, done: done)
      if done, x != nil, i < albumTokens.count {
        let u = effectiveURI(md)
        if !u.isEmpty && !albumTokens[i].hasPrefix(u + "#") {
          let f = L.albumFrames[i]
          setImage(albumViews[i], slot: i, uri: u, thumb: md.thumb, maxPixel: max(f.width, f.height) * scale, animated: false)
        }
      }
    }
    // áudio: o botão play vira o anel enquanto baixa
    if let au = row.audio, !L.audioFrame.isEmpty {
      if let d = au.dl { keys.insert(d.key) }
      let (mode, done, _) = xferState(au.dl, up: nil, sizeText: false)
      audioRing.tint = row.own ? style0?.theme.ownText ?? .white : style0?.theme.otherText ?? .black
      let b = CMLAudioView.buttonSize
      let btn = CGRect(x: L.audioFrame.minX, y: L.audioFrame.minY + 1, width: b, height: b).offsetBy(dx: o.x, dy: o.y)
      place(ring: audioRing, mode: mode, in: btn, animated: animated, done: done)
      audio.glyphHidden = mode != .hidden
    } else {
      audioRing.reset()
      audio.glyphHidden = false
    }
    // arquivo: anel no ícone + "1,2 MB de 4,5 MB"
    if let f = row.file, !L.fileFrame.isEmpty {
      if let d = f.dl { keys.insert(d.key) }
      let (mode, done, x) = xferState(f.dl, up: nil, sizeText: false)
      let tint = row.own ? (style0?.theme.ownText ?? .white) : (style0?.theme.accent ?? .black)
      fileRing.tint = tint
      let ff = L.fileFrame
      let icon = CGRect(x: ff.minX, y: ff.minY + max(0, (ff.height - 44) / 2) + 3, width: 38, height: 38).offsetBy(dx: o.x, dy: o.y)
      place(ring: fileRing, mode: mode, in: icon, animated: animated, done: done)
      fileView.extHidden = mode != .hidden
      if let x = x, x.state == .running, !done {
        let t = CMLTransfers.shared.progressText(x)
        if t.isEmpty { fileView.sizeOverride = nil } else {
          let c = row.own ? (style0?.theme.ownMeta ?? .lightGray) : (style0?.theme.otherMeta ?? .gray)
          fileView.sizeOverride = NSAttributedString(string: t, attributes: [.font: style0?.meta ?? UIFont.systemFont(ofSize: 12), .foregroundColor: c])
        }
      } else {
        fileView.sizeOverride = nil
      }
    } else {
      fileRing.reset()
      fileView.extHidden = false
      fileView.sizeOverride = nil
    }
    transferKeys = keys
  }

  private func place(ring: CMLTransferRing, mode: CMLTransferRing.Mode, in rect: CGRect, animated: Bool, done: Bool) {
    if mode == .hidden {
      if animated && done && !ring.isHidden { ring.finish() } else if !(animated && done) { ring.set(.hidden, animated: false) }
      return
    }
    let sz = ring.preferredSize(mode)
    let f = CGRect(x: rect.midX - sz.width / 2, y: rect.midY - sz.height / 2, width: sz.width, height: sz.height)
    if ring.bounds.size != f.size || ring.center != CGPoint(x: f.midX, y: f.midY) {
      ring.bounds = CGRect(origin: .zero, size: f.size)
      ring.center = CGPoint(x: f.midX, y: f.midY)
    }
    ring.set(mode, animated: animated)
  }

  /// Toque cai num anel/botão de baixar? (ponto em coords do balão)
  fileprivate func xferHit(_ bp: CGPoint, _ L: CMLRowLayout) -> Int? {
    guard let row = row else { return nil }
    let o = L.bubbleFrame.origin
    func ringHit(_ r: CMLTransferRing) -> Bool {
      if r.isHidden || r.mode == .hidden { return false }
      return r.frame.offsetBy(dx: -o.x, dy: -o.y).insetBy(dx: -12, dy: -12).contains(bp)
    }
    // botão "baixar": a mídia inteira; baixando: só o anel (X) — fora dele abre
    func isDownloadButton(_ r: CMLTransferRing) -> Bool {
      if case .download = r.mode { return !r.isHidden }
      return false
    }
    if let md = row.media, !L.mediaFrame.isEmpty, md.kind != "sticker" {
      if md.up != nil { return ringHit(xRing) ? -1 : nil }
      // foto/vídeo ainda não baixado: o balão inteiro baixa (WhatsApp)
      if md.dl != nil && !xRing.isHidden && (isDownloadButton(xRing) ? L.mediaFrame.contains(bp) : ringHit(xRing)) { return -1 }
    }
    for (i, r) in albumRings.enumerated() where i < L.albumFrames.count && i < row.album.count {
      let md = row.album[i]
      if md.up != nil { if ringHit(r) { return i }; continue }
      if md.dl != nil && !r.isHidden && L.albumFrames[i].contains(bp) && (isDownloadButton(r) || ringHit(r)) { return i }
    }
    if row.audio != nil && !audioRing.isHidden && !L.audioFrame.isEmpty {
      let b = CMLAudioView.buttonSize
      if CGRect(x: L.audioFrame.minX, y: L.audioFrame.minY, width: b + 12, height: L.audioFrame.height).insetBy(dx: -8, dy: -6).contains(bp) { return CMLCell.xferAudio }
    }
    if row.file != nil && !fileRing.isHidden && !L.fileFrame.isEmpty && L.fileFrame.contains(bp) { return CMLCell.xferFile }
    return nil
  }

  /// dl / up do slot (p/ a lista decidir baixar, cancelar ou mandar ao JS).
  func xferInfo(_ slot: Int) -> (CMLMediaDL?, Int?) {
    guard let row = row else { return (nil, nil) }
    switch slot {
    case -1: return (row.media?.dl, row.media?.up)
    case CMLCell.xferAudio: return (row.audio?.dl, nil)
    case CMLCell.xferFile: return (row.file?.dl, nil)
    default: return slot >= 0 && slot < row.album.count ? (row.album[slot].dl, row.album[slot].up) : (nil, nil)
    }
  }

  /// Auto-download (política do usuário) das mídias desta linha.
  func autoStartTransfers(owner: CMLTransferObserver) {
    guard let row = row, row.kind == .msg, !row.deleted else { return }
    var dls: [CMLMediaDL] = []
    if let d = row.media?.dl, row.media?.up == nil { dls.append(d) }
    for m in row.album where m.up == nil { if let d = m.dl { dls.append(d) } }
    if let d = row.audio?.dl { dls.append(d) }
    if let d = row.file?.dl { dls.append(d) }
    let T = CMLTransfers.shared
    for d in dls where !d.js {
      let x = T.probe(d)
      if x.state == .none && !x.autoTried && T.allowsAuto(d.bucket) { T.start(d, user: false, owner: owner) }
    }
  }
}


// MARK: - [2026-10-18 tg-list, apiVersion 11]

extension CMLCell {
  /// Realce da busca no texto do balão (intervalos do layout.attr).
  func applySearch(_ r: [NSRange], cur: Bool) {
    guard let th = style0?.theme else { textView.setMarks([], color: .clear); return }
    textView.setMarks(r, color: cur ? th.searchCur : th.search)
  }

  /// Texto exibido no balão (base dos intervalos da busca).
  var displayedText: String? {
    return layoutInfo?.text?.attr.string
  }

  /// Arrastar-p/-selecionar: pinta o estado otimista (2 = marcada, 1 = não) sem
  /// mexer no modelo; nil volta ao `row.sel`.
  func previewSel(_ sel: Int?) {
    guard let row = row, row.kind == .msg, row.sel > 0, let th = style0?.theme else { return }
    let v = sel ?? row.sel
    let k: CMLIconView.Kind = v == 2 ? .selectOn : .select
    if selIcon.kind != k {
      selIcon.kind = k
      if !UIAccessibility.isReduceMotionEnabled {
        selIcon.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
        UIView.animate(withDuration: 0.2, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0, options: [.allowUserInteraction], animations: {
          self.selIcon.transform = .identity
        })
      }
    }
    highlight.layer.removeAllAnimations()
    highlight.backgroundColor = v == 2 ? th.selection : th.highlight
    highlight.alpha = v == 2 ? 1 : 0
  }

  /// Toque duplo = reação rápida: o emoji salta no centro do balão e sobe sumindo.
  func popQuickReact(_ emoji: String) {
    guard let L = layoutInfo else { return }
    quickPop?.removeFromSuperview()
    let lb = UILabel()
    lb.text = emoji
    lb.font = UIFont.systemFont(ofSize: 34)
    lb.sizeToFit()
    let c = CGPoint(x: L.bubbleFrame.midX + slide.transform.tx, y: L.bubbleFrame.midY)
    lb.center = c
    lb.isUserInteractionEnabled = false
    contentView.addSubview(lb)
    quickPop = lb
    if UIAccessibility.isReduceMotionEnabled {
      lb.alpha = 1
      UIView.animate(withDuration: 0.5, delay: 0.25, options: [.allowUserInteraction], animations: { lb.alpha = 0 }, completion: { _ in
        lb.removeFromSuperview()
      })
      return
    }
    lb.transform = CGAffineTransform(scaleX: 0.2, y: 0.2)
    lb.alpha = 0.4
    UIView.animateKeyframes(withDuration: 0.62, delay: 0, options: [.allowUserInteraction, .calculationModeCubic], animations: {
      UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.3) {
        lb.transform = CGAffineTransform(scaleX: 1.25, y: 1.25); lb.alpha = 1
      }
      UIView.addKeyframe(withRelativeStartTime: 0.3, relativeDuration: 0.2) {
        lb.transform = .identity
      }
      UIView.addKeyframe(withRelativeStartTime: 0.5, relativeDuration: 0.5) {
        lb.transform = CGAffineTransform(translationX: 0, y: -24).scaledBy(x: 0.9, y: 0.9)
        lb.alpha = 0
      }
    }, completion: { [weak self, weak lb] _ in
      lb?.removeFromSuperview()
      if let s = self, s.quickPop === lb { s.quickPop = nil }
    })
  }

  /// Bolha elegível ao toque duplo: texto puro ou figurinha.
  static func quickReactEligible(_ r: CMLRow) -> Bool {
    guard r.kind == .msg, r.sel == 0, !r.deleted else { return false }
    if let m = r.media { return m.kind == "sticker" && r.album.isEmpty }
    return !r.text.isEmpty && r.album.isEmpty && r.audio == nil && r.file == nil
  }
}
