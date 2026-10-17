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
  // [fase 2]
  let blocks = CMLBlocksView()
  let failIcon = CMLIconView()
  /// (key, "play"|"pause"|"end") da nota de vídeo
  var onVideoNote: ((String, String) -> Void)?
  /// [wave13-C a11y] toque duplo do VoiceOver → ação principal da bolha (a lista decide)
  var onA11yActivate: ((CMLCell) -> Bool)?
  private var revealed = false
  private var lifted = false
  /// [2026-10-15 native-effects] emoji grande aguardando o willDisplay p/ animar 1×
  private var jumboPending = false

  private(set) var key: String = ""
  private(set) var row: CMLRow?
  private(set) var layoutInfo: CMLRowLayout?
  private var mediaToken = ""
  private var albumTokens: [String] = []

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
    slide.addSubview(media)
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
    audio.resetPlayback()
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
    pillBg.isHidden = !isPill
    pillText.isHidden = !isPill
    slide.isHidden = isPill
    selIcon.isHidden = isPill || row.sel == 0
    if isPill {
      pillText.layout = L.pillText
      pillText.frame = L.pillTextFrame
      pillBg.frame = L.pillFrame
      switch row.kind {
      case .unread:
        pillBg.backgroundColor = th.unreadBg
        pillBg.layer.cornerRadius = 0
      default:
        pillBg.backgroundColor = th.pillBg
        pillBg.layer.cornerRadius = min(8, L.pillFrame.height / 2) // [2026-10-17 wa-pills]
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
    } else {
      bubble.isHidden = true
      bubble.path = nil
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
      media.layer.cornerRadius = L.mediaRadius
      media.contentMode = md.kind == "sticker" ? .scaleAspectFit : .scaleAspectFill
      media.backgroundColor = md.kind == "sticker" ? .clear : (row.own ? th.ownQuote : th.otherQuote)
      let px = max(L.mediaFrame.width, L.mediaFrame.height) * scale
      setImage(media, slot: -1, uri: effectiveURI(md), thumb: md.thumb, maxPixel: px, animated: md.kind == "gif" || md.kind == "sticker")
      let isVideo = md.kind == "video"
      let showPlay = isVideo && md.up == nil
      playBadge.isHidden = !showPlay
      if showPlay {
        let s: CGFloat = 46
        playBadge.frame = CGRect(x: L.mediaFrame.midX - s / 2, y: L.mediaFrame.midY - s / 2, width: s, height: s).offsetBy(dx: o.x, dy: o.y)
      }
      if (isVideo || md.kind == "gif") && !md.dur.isEmpty { // [2026-10-16 gif] pílula "GIF"
        durLabel.isHidden = false
        let dl = CMLLayoutBuilder.line(md.dur, font: s.meta, color: .white, maxWidth: 80)
        durLabel.layout = dl
        durLabel.frame = CGRect(x: L.mediaFrame.minX + 8, y: L.mediaFrame.maxY - dl.size.height - 7, width: dl.size.width + 1, height: dl.size.height).offsetBy(dx: o.x, dy: o.y)
        durLabel.layer.shadowColor = UIColor.black.cgColor
        durLabel.layer.shadowOpacity = 0.6
        durLabel.layer.shadowRadius = 2
        durLabel.layer.shadowOffset = .zero
      } else {
        durLabel.isHidden = true
      }
      mediaDim.frame = media.frame
      mediaDim.layer.cornerRadius = L.mediaRadius
    } else {
      media.isHidden = true
      media.image = nil
      mediaToken = ""
      playBadge.isHidden = true
      durLabel.isHidden = true
      mediaDim.isHidden = true
    }

    // álbum
    if !row.album.isEmpty && !L.albumFrames.isEmpty {
      if albumTokens.count != 4 { albumTokens = ["", "", "", ""] }
      for i in 0..<4 {
        let iv = albumViews[i]
        if i < L.albumFrames.count && i < row.album.count {
          let md = row.album[i]
          place(iv, L.albumFrames[i], true)
          iv.backgroundColor = row.own ? th.ownQuote : th.otherQuote
          let f = L.albumFrames[i]
          setImage(iv, slot: i, uri: effectiveURI(md), thumb: md.thumb, maxPixel: max(f.width, f.height) * scale, animated: false)
        } else {
          iv.isHidden = true
          iv.image = nil
          albumTokens[i] = ""
        }
      }
      if row.more > 0, let last = L.albumFrames.last {
        moreDim.isHidden = false
        moreDim.frame = last.offsetBy(dx: o.x, dy: o.y)
        moreDim.layer.cornerRadius = 4
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

    // reações (coordenadas da linha, não do balão)
    if !L.reactChips.isEmpty {
      reacts.isHidden = false
      // bounds+center (não frame): o "pop" do menu nativo anima o transform
      reacts.bounds = CGRect(origin: .zero, size: L.reactsFrame.size)
      reacts.center = CGPoint(x: L.reactsFrame.midX, y: L.reactsFrame.midY)
      reacts.bg = th.reactBg
      reacts.border = th.reactBorder
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
  }

  private func setImage(_ iv: UIImageView, slot: Int, uri: String, thumb: String, maxPixel: CGFloat, animated: Bool) {
    let tok = uri + "#" + thumb
    let cur = slot < 0 ? mediaToken : (slot < albumTokens.count ? albumTokens[slot] : "")
    if cur == tok && iv.image != nil { return }
    if slot < 0 { mediaToken = tok } else if slot < albumTokens.count { albumTokens[slot] = tok }
    let loader = CMLImageLoader.shared
    if let img = loader.cached(uri, maxPixel: maxPixel) { iv.image = img; return }
    if !thumb.isEmpty, let t = loader.cached(thumb, maxPixel: 96) { iv.image = t } else { iv.image = nil }
    let myTok = tok
    if !thumb.isEmpty && iv.image == nil {
      loader.load(thumb, maxPixel: 96) { [weak iv] img in
        guard let iv = iv, iv.image == nil, let img = img else { return }
        if self.currentToken(for: iv) == myTok { iv.image = img }
      }
    }
    if uri.isEmpty { return }
    loader.load(uri, maxPixel: maxPixel, animated: animated) { [weak self, weak iv] img in
      guard let self = self, let iv = iv, let img = img else { return }
      guard self.currentToken(for: iv) == myTok else { return }
      if iv.image != nil {
        UIView.transition(with: iv, duration: 0.18, options: [.transitionCrossDissolve, .allowUserInteraction], animations: { iv.image = img })
      } else {
        iv.image = img
      }
    }
  }

  private func currentToken(for iv: UIImageView) -> String {
    if iv === media { return mediaToken }
    if let i = albumViews.firstIndex(where: { $0 === iv }), i < albumTokens.count { return albumTokens[i] }
    return ""
  }

  // MARK: hit test (ponto em coordenadas do contentView)

  enum Part { case bubble, media(Int), reply, link(String, Int), audio, file, reaction(Int), action(String, CGRect, CGFloat), retry, vnote(Int), spoiler, xfer(Int), none }

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
