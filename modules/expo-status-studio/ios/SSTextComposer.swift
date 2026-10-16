import UIKit

// [2026-10-15 native-status-studio] Status de TEXTO nativo (nível WhatsApp).
// Teclado aberto: campo com auto-ajuste no espaço livre + fileira de fontes.
// Teclado fechado: PRÉVIA idêntica ao visualizador nativo (mesma fonte, caixa
// w−48 × 70% da tela, busca binária 14…44, entrelinha .12) — toque no fundo
// troca a cor/gradiente, toque no texto volta a editar.

final class SSGradientView: UIView {
  override class var layerClass: AnyClass { return CAGradientLayer.self }
  var gradient: CAGradientLayer { return layer as! CAGradientLayer }

  func set(_ colors: [UIColor]) {
    let cs = colors.count >= 2 ? colors : [colors.first ?? .black, colors.first ?? .black]
    gradient.startPoint = CGPoint(x: 0, y: 0)
    gradient.endPoint = CGPoint(x: 1, y: 1)
    gradient.colors = cs.map { $0.cgColor }
    backgroundColor = cs.last
  }
}

final class SSTextComposer: UIView, UITextViewDelegate {
  var onClose: (() -> Void)?
  var onSend: (() -> Void)?
  var onGallery: (() -> Void)?
  var onCamera: (() -> Void)?
  var onAudience: (() -> Void)?

  private let opts: SSOptions
  let bg = SSGradientView()
  private let tapCatcher = UIControl()
  let textView = UITextView()
  private let previewLabel = UILabel()
  private let placeholder = UILabel()
  private let topBar = UIView()
  private let closeBtn = UIButton(type: .system)
  private var rightBtns: [UIButton] = []
  private let fontRow = UIScrollView()
  private var fontChips: [UIButton] = []
  private let bottomBar = UIView()
  let audPill = UIButton(type: .custom)
  private let counter = UILabel()
  private let sendBtn = UIButton(type: .custom)
  private let linkPill = UILabel()
  private let flash = UILabel()
  private var flashTimer: Timer?
  private var alignBtn: UIButton?
  private var letterBtn: UIButton?

  var bgIndex = 0
  var font = "sans"
  var align: NSTextAlignment = .center
  var letterBg = 0                    // 0 nenhum · 1 sólido · 2 suave
  var keyboardInset: CGFloat = 0 { didSet { setNeedsLayout() } }
  var text: String { return textView.text ?? "" }
  var trimmed: String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
  var isEditingText: Bool { return textView.isFirstResponder }

  init(opts: SSOptions) {
    self.opts = opts
    super.init(frame: .zero)
    backgroundColor = .black
    bgIndex = opts.textBgIndex
    font = opts.fonts.first?.id ?? "sans"
    addSubview(bg)
    tapCatcher.addTarget(self, action: #selector(tapBackground), for: .touchUpInside)
    addSubview(tapCatcher)

    previewLabel.numberOfLines = 0
    previewLabel.isUserInteractionEnabled = true
    previewLabel.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(beginEdit)))
    addSubview(previewLabel)

    textView.backgroundColor = .clear
    textView.textColor = .white
    textView.tintColor = .white
    textView.keyboardAppearance = .dark
    textView.isScrollEnabled = true
    textView.showsVerticalScrollIndicator = false
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.delegate = self
    textView.accessibilityLabel = opts.t("typeStatus", "Digite um status")
    addSubview(textView)

    placeholder.text = opts.t("typeStatus", "Digite um status")
    placeholder.textColor = UIColor(white: 1, alpha: 0.6)
    placeholder.textAlignment = .center
    placeholder.numberOfLines = 2
    placeholder.isUserInteractionEnabled = false
    addSubview(placeholder)

    flash.textColor = .white
    flash.font = .systemFont(ofSize: 15, weight: .bold)
    flash.textAlignment = .center
    flash.backgroundColor = UIColor(white: 0, alpha: 0.35)
    flash.layer.cornerRadius = 16
    flash.clipsToBounds = true
    flash.alpha = 0
    addSubview(flash)

    // topo
    addSubview(topBar)
    glass(closeBtn, "xmark", opts.t("close", "Fechar"))
    closeBtn.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
    topBar.addSubview(closeBtn)
    let fontBtn = glassButton(nil, opts.t("font", "Fonte"))
    fontBtn.setTitle("Aa", for: .normal)
    fontBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
    fontBtn.addAction(UIAction { [weak self] _ in self?.cycleFont() }, for: .touchUpInside)
    let colorBtn = glassButton("paintpalette", opts.t("color", "Trocar cor"))
    colorBtn.addAction(UIAction { [weak self] _ in self?.cycleBg() }, for: .touchUpInside)
    let aBtn = glassButton("text.aligncenter", opts.t("align", "Alinhamento"))
    aBtn.addAction(UIAction { [weak self] _ in self?.cycleAlign() }, for: .touchUpInside)
    alignBtn = aBtn
    let lBtn = glassButton("character.textbox", opts.t("textBg", "Fundo do texto"))
    lBtn.addAction(UIAction { [weak self] _ in self?.cycleLetterBg() }, for: .touchUpInside)
    letterBtn = lBtn
    rightBtns = [fontBtn, colorBtn, aBtn, lBtn]
    if opts.canGallery {
      let g = glassButton("photo.on.rectangle", opts.t("gallery", "Galeria"))
      g.addAction(UIAction { [weak self] _ in self?.onGallery?() }, for: .touchUpInside)
      rightBtns.append(g)
    }
    if opts.canCamera {
      let c = glassButton("camera", opts.t("camera", "Câmera"))
      c.addAction(UIAction { [weak self] _ in self?.onCamera?() }, for: .touchUpInside)
      rightBtns.append(c)
    }
    for b in rightBtns { topBar.addSubview(b) }

    // fontes (acima do teclado)
    fontRow.showsHorizontalScrollIndicator = false
    for f in opts.fonts {
      let b = UIButton(type: .custom)
      b.setTitle(f.label, for: .normal)
      b.titleLabel?.font = SSFont.font(f.id, size: 15)
      b.layer.cornerRadius = 16
      b.layer.borderWidth = 1
      b.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
      let id = f.id
      b.addAction(UIAction { [weak self] _ in self?.setFont(id) }, for: .touchUpInside)
      fontRow.addSubview(b)
      fontChips.append(b)
    }
    addSubview(fontRow)

    // rodapé
    audPill.backgroundColor = UIColor(white: 0, alpha: 0.25)
    audPill.layer.cornerRadius = 18
    audPill.setTitleColor(.white, for: .normal)
    audPill.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
    audPill.tintColor = .white
    audPill.contentEdgeInsets = UIEdgeInsets(top: 0, left: 12, bottom: 0, right: 14)
    audPill.titleEdgeInsets = UIEdgeInsets(top: 0, left: 6, bottom: 0, right: -6)
    audPill.addAction(UIAction { [weak self] _ in self?.textView.resignFirstResponder(); self?.onAudience?() }, for: .touchUpInside)
    bottomBar.addSubview(audPill)
    counter.textColor = UIColor(white: 1, alpha: 0.75)
    counter.font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
    counter.textAlignment = .right
    bottomBar.addSubview(counter)
    sendBtn.backgroundColor = .white
    sendBtn.layer.cornerRadius = 26
    sendBtn.setImage(ssSymbol("paperplane.fill", 20, .semibold)?.withTintColor(.black, renderingMode: .alwaysOriginal), for: .normal)
    sendBtn.accessibilityLabel = opts.t("share", "Seu status")
    sendBtn.addAction(UIAction { [weak self] _ in self?.onSend?() }, for: .touchUpInside)
    bottomBar.addSubview(sendBtn)
    addSubview(bottomBar)

    linkPill.textColor = .white
    linkPill.font = .systemFont(ofSize: 13, weight: .semibold)
    linkPill.backgroundColor = UIColor(white: 0, alpha: 0.3)
    linkPill.layer.cornerRadius = 14
    linkPill.clipsToBounds = true
    linkPill.textAlignment = .center
    linkPill.isHidden = true
    addSubview(linkPill)

    applyBg()
    paintChips()
    paintToggles()
    refresh()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  private func glass(_ b: UIButton, _ sym: String, _ label: String) {
    b.setImage(ssSymbol(sym, 17, .semibold), for: .normal)
    b.tintColor = .white
    b.backgroundColor = UIColor(white: 0, alpha: 0.28)
    b.layer.cornerRadius = 20
    b.accessibilityLabel = label
  }

  private func glassButton(_ sym: String?, _ label: String) -> UIButton {
    let b = UIButton(type: .system)
    if let s = sym { glass(b, s, label) } else {
      b.tintColor = .white
      b.setTitleColor(.white, for: .normal)
      b.backgroundColor = UIColor(white: 0, alpha: 0.28)
      b.layer.cornerRadius = 20
      b.accessibilityLabel = label
    }
    return b
  }

  func setAudience(title: String, symbol: String) {
    audPill.setTitle(title, for: .normal)
    audPill.setImage(ssSymbol(symbol, 13, .semibold), for: .normal)
    setNeedsLayout()
  }

  // MARK: estado

  private func applyBg() {
    let list = opts.textBackgrounds
    guard !list.isEmpty else { return }
    bgIndex = ((bgIndex % list.count) + list.count) % list.count
    bg.set(list[bgIndex].colors)
  }

  var bgValue: String { return opts.textBackgrounds.isEmpty ? "#111111" : opts.textBackgrounds[bgIndex].value }

  @objc private func tapBackground() {
    if textView.isFirstResponder {
      textView.resignFirstResponder()
      return
    }
    if trimmed.isEmpty { beginEdit(); return }
    cycleBg()
  }

  @objc func beginEdit() {
    textView.becomeFirstResponder()
  }

  private func cycleBg() {
    ssHaptic("select")
    bgIndex += 1
    UIView.transition(with: bg, duration: 0.2, options: .transitionCrossDissolve, animations: { self.applyBg() })
  }

  private func cycleFont() {
    let ids = opts.fonts.map { $0.id }
    guard !ids.isEmpty else { return }
    let i = ids.firstIndex(of: font) ?? -1
    setFont(ids[(i + 1) % ids.count])
  }

  private func setFont(_ id: String) {
    ssHaptic("select")
    font = id
    paintChips()
    refresh()
    showFlash(opts.fonts.first { $0.id == id }?.label ?? id)
  }

  private func cycleAlign() {
    ssHaptic("select")
    align = align == .center ? .left : (align == .left ? .right : .center)
    paintToggles()
    refresh()
  }

  private func cycleLetterBg() {
    ssHaptic("select")
    letterBg = (letterBg + 1) % 3
    paintToggles()
    refresh()
  }

  private func paintChips() {
    for (i, b) in fontChips.enumerated() {
      let on = opts.fonts[i].id == font
      b.backgroundColor = on ? .white : UIColor(white: 0, alpha: 0.25)
      b.setTitleColor(on ? .black : .white, for: .normal)
      b.layer.borderColor = on ? UIColor.white.cgColor : UIColor(white: 1, alpha: 0.35).cgColor
    }
  }

  private func paintToggles() {
    let sym = align == .left ? "text.alignleft" : (align == .right ? "text.alignright" : "text.aligncenter")
    alignBtn?.setImage(ssSymbol(sym, 17, .semibold), for: .normal)
    letterBtn?.backgroundColor = letterBg == 0 ? UIColor(white: 0, alpha: 0.28) : (letterBg == 1 ? .white : UIColor(white: 1, alpha: 0.4))
    letterBtn?.tintColor = letterBg == 1 ? .black : .white
  }

  private func showFlash(_ s: String) {
    flash.text = "  \(s)  "
    setNeedsLayout()
    flashTimer?.invalidate()
    UIView.animate(withDuration: 0.15) { self.flash.alpha = 1 }
    flashTimer = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: false) { [weak self] _ in
      UIView.animate(withDuration: 0.25) { self?.flash.alpha = 0 }
    }
  }

  /// Exporta como IMAGEM só com fundo da letra — alinhamento vai como meta.text_align
  /// do status de texto ([status-texto 2026-10-16]; servidor e viewers já entendem).
  var needsImage: Bool { return letterBg != 0 }
  var alignValue: String { return align == .left ? "left" : (align == .right ? "right" : "center") }

  /// Atributos de "fundo da letra" sobre o texto do layout do viewer.
  static func styled(_ base: NSAttributedString, letterBg: Int) -> NSAttributedString {
    guard letterBg != 0 else { return base }
    let m = NSMutableAttributedString(attributedString: base)
    let r = NSRange(location: 0, length: m.length)
    if letterBg == 1 {
      m.addAttribute(.backgroundColor, value: UIColor.white, range: r)
      m.addAttribute(.foregroundColor, value: UIColor.black, range: r)
    } else {
      m.addAttribute(.backgroundColor, value: UIColor(white: 0, alpha: 0.35), range: r)
    }
    return m
  }

  func refresh() {
    let len = text.count
    counter.text = "\(len)/\(opts.textMax)"
    counter.textColor = len >= opts.textMax - 50 ? .white : UIColor(white: 1, alpha: 0.75)
    placeholder.isHidden = !text.isEmpty
    placeholder.font = SSFont.font(font, size: 32)
    sendBtn.alpha = trimmed.isEmpty ? 0.45 : 1
    sendBtn.isEnabled = !trimmed.isEmpty
    if let u = SSTextComposer.firstLink(text) {
      linkPill.text = "  " + u.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "") + "  "
      linkPill.isHidden = false
    } else {
      linkPill.isHidden = true
    }
    setNeedsLayout()
  }

  static func firstLink(_ s: String) -> String? {
    guard !s.isEmpty, let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
    let ns = s as NSString
    for m in det.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)) {
      if let u = m.url, u.scheme?.hasPrefix("http") == true {
        if m.range.location > 0 && ns.substring(with: NSRange(location: m.range.location - 1, length: 1)) == "@" { continue }
        return u.absoluteString
      }
    }
    return nil
  }

  // MARK: UITextViewDelegate

  func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText t: String) -> Bool {
    let cur = (tv.text ?? "") as NSString
    let next = cur.replacingCharacters(in: range, with: t)
    return next.count <= opts.textMax
  }

  func textViewDidChange(_ tv: UITextView) { refresh() }
  func textViewDidBeginEditing(_ tv: UITextView) { setNeedsLayout(); UIView.animate(withDuration: 0.2) { self.layoutIfNeeded() } }
  func textViewDidEndEditing(_ tv: UITextView) { setNeedsLayout(); UIView.animate(withDuration: 0.2) { self.layoutIfNeeded() } }

  // MARK: layout

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    let H = bounds.height
    let safe = safeAreaInsets
    bg.frame = bounds
    tapCatcher.frame = bounds
    topBar.frame = CGRect(x: 0, y: safe.top, width: W, height: 56)
    closeBtn.frame = CGRect(x: 12, y: 8, width: 40, height: 40)
    var x = W - 12
    for b in rightBtns.reversed() {
      x -= 40
      b.frame = CGRect(x: x, y: 8, width: 40, height: 40)
      x -= 8
    }
    let editing = textView.isFirstResponder
    let bottomH: CGFloat = 68
    bottomBar.frame = CGRect(x: 0, y: H - max(safe.bottom, editing ? keyboardInset : 0) - bottomH, width: W, height: bottomH)
    sendBtn.frame = CGRect(x: W - 16 - 52, y: 8, width: 52, height: 52)
    counter.frame = CGRect(x: sendBtn.frame.minX - 90, y: 8, width: 78, height: 52)
    let aw = min(W * 0.5, audPill.intrinsicContentSize.width + 16)
    audPill.frame = CGRect(x: 16, y: 16, width: aw, height: 36)

    // fontes logo acima do rodapé quando editando
    fontRow.isHidden = !editing
    var cx: CGFloat = 12
    for b in fontChips {
      let w = max(64, b.intrinsicContentSize.width)
      b.frame = CGRect(x: cx, y: 4, width: w, height: 32)
      cx += w + 8
    }
    fontRow.contentSize = CGSize(width: cx + 4, height: 40)
    fontRow.frame = CGRect(x: 0, y: bottomBar.frame.minY - 44, width: W, height: 40)

    let fullPreview = !editing
    textView.isHidden = fullPreview && !text.isEmpty
    previewLabel.isHidden = !textView.isHidden
    if fullPreview && !text.isEmpty {
      // Prévia = layout do visualizador (tela cheia)
      let (s, _, th) = SSTextStatus.fit(text, font: font, width: W, height: H, align: align)
      previewLabel.attributedText = SSTextComposer.styled(s, letterBg: letterBg)
      previewLabel.frame = CGRect(x: 24, y: (H - th) / 2, width: W - 48, height: th)
    } else {
      let top = topBar.frame.maxY + 4
      let bottom = (editing ? fontRow.frame.minY : bottomBar.frame.minY) - 8
      let areaH = max(80, bottom - top)
      let (s, fs, th) = SSTextStatus.fit(text.isEmpty ? " " : text, font: font, width: W, height: areaH / 0.86, align: align)
      let key = "\(font)|\(fs)|\(align.rawValue)|\(letterBg)"
      let attrs0 = s.attributes(at: 0, effectiveRange: nil)
      let styledAttrs = SSTextComposer.styled(NSAttributedString(string: " ", attributes: attrs0), letterBg: letterBg).attributes(at: 0, effectiveRange: nil)
      // Só reestiliza quando a fonte/tamanho/alinhamento/fundo mudam e nunca no
      // meio de uma composição (IME / teclado preditivo).
      if key != styleKey && textView.markedTextRange == nil {
        styleKey = key
        let sel = textView.selectedRange
        textView.attributedText = NSAttributedString(string: text, attributes: styledAttrs)
        textView.selectedRange = sel
      }
      textView.typingAttributes = styledAttrs
      textView.autocapitalizationType = font == "condensed" ? .allCharacters : .sentences
      let h = min(areaH, max(fs * 1.4, th))
      textView.frame = CGRect(x: 24, y: top + (areaH - h) / 2, width: W - 48, height: h)
      placeholder.frame = CGRect(x: 24, y: top + (areaH - 90) / 2, width: W - 48, height: 90)
    }
    if !editing && text.isEmpty {
      placeholder.frame = CGRect(x: 24, y: (H - 90) / 2, width: W - 48, height: 90)
    }
    let lw = min(W - 40, linkPill.intrinsicContentSize.width)
    linkPill.frame = CGRect(x: (W - lw) / 2, y: (editing ? fontRow.frame.minY : bottomBar.frame.minY) - 36, width: lw, height: 28)
    let fw = min(W - 40, flash.intrinsicContentSize.width + 8)
    flash.frame = CGRect(x: (W - fw) / 2, y: topBar.frame.maxY + 12, width: fw, height: 32)
  }

  private var styleKey = ""

  /// JPEG com a mesma conta da prévia, no tamanho/proporção da tela (×1080/W).
  func renderImage() -> UIImage {
    let W = max(1, bounds.width)
    let H = max(1, bounds.height)
    let scale = 1080 / W
    let fmt = UIGraphicsImageRendererFormat.default()
    fmt.scale = scale
    fmt.opaque = true
    let colors = opts.textBackgrounds.isEmpty ? [UIColor.black] : opts.textBackgrounds[bgIndex].colors
    let (s, _, th) = SSTextStatus.fit(text, font: font, width: W, height: H, align: align)
    let str = SSTextComposer.styled(s, letterBg: letterBg)
    return UIGraphicsImageRenderer(size: CGSize(width: W, height: H), format: fmt).image { r in
      let ctx = r.cgContext
      let cs = colors.count >= 2 ? colors : [colors[0], colors[0]]
      if let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: cs.map { $0.cgColor } as CFArray, locations: nil) {
        ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: W, y: H), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
      }
      str.draw(with: CGRect(x: 24, y: (H - th) / 2, width: W - 48, height: th), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
    }
  }
}
