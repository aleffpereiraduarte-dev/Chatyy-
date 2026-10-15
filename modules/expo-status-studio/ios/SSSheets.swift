import UIKit

// [2026-10-15 native-status-studio] Folhas e formulários do estúdio (P&B,
// vidro escuro, SF Symbols — sem emoji na UI): bandeja de figurinhas, lista
// (menção/música), formulário com prévia ao vivo do bloco (enquete, pergunta,
// contagem, link, local) e público.

let ssSheetBg = UIColor(white: 0.08, alpha: 1)
let ssFieldBg = UIColor(white: 1, alpha: 0.09)

// MARK: - Folha inferior genérica

final class SSSheet: UIView {
  let panel = UIView()
  let content = UIView()
  private let dim = UIControl()
  private let grabber = UIView()
  private let handle = UIView()
  var heightFraction: CGFloat = 0.6
  var fixedHeight: CGFloat = 0
  var keyboardInset: CGFloat = 0 { didSet { setNeedsLayout(); layoutIfNeeded() } }
  var onClose: (() -> Void)?
  /// Sempre chamado ao sair (qualquer caminho) — p/ quebrar ciclos do conteúdo.
  var onGone: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    dim.backgroundColor = UIColor(white: 0, alpha: 0.45)
    dim.addTarget(self, action: #selector(tapDim), for: .touchUpInside)
    addSubview(dim)
    panel.backgroundColor = ssSheetBg
    panel.layer.cornerRadius = 20
    panel.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    panel.clipsToBounds = true
    addSubview(panel)
    grabber.backgroundColor = UIColor(white: 1, alpha: 0.28)
    grabber.layer.cornerRadius = 2.5
    panel.addSubview(grabber)
    panel.addSubview(content)
    // Arrastar p/ baixo só pela faixa do topo (listas/grades rolam normalmente).
    panel.addSubview(handle)
    handle.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(onPan(_:))))
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  private var panelH: CGFloat {
    let h = fixedHeight > 0 ? fixedHeight : bounds.height * heightFraction
    return min(bounds.height - safeAreaInsets.top - 20, h + safeAreaInsets.bottom)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    dim.frame = bounds
    let h = panelH
    let lift = max(0, keyboardInset - safeAreaInsets.bottom)
    panel.frame = CGRect(x: 0, y: bounds.height - h - lift, width: bounds.width, height: h + lift)
    grabber.frame = CGRect(x: (bounds.width - 38) / 2, y: 8, width: 38, height: 5)
    handle.frame = CGRect(x: 0, y: 0, width: bounds.width, height: 24)
    content.frame = CGRect(x: 0, y: 22, width: bounds.width, height: h - 22 - safeAreaInsets.bottom)
  }

  func show(in host: UIView) {
    frame = host.bounds
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
    host.addSubview(self)
    layoutIfNeeded()
    dim.alpha = 0
    panel.transform = CGAffineTransform(translationX: 0, y: panel.bounds.height)
    UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0.4, options: [.allowUserInteraction]) {
      self.dim.alpha = 1
      self.panel.transform = .identity
    }
  }

  func dismiss(_ done: (() -> Void)? = nil) {
    endEditing(true)
    UIView.animate(withDuration: 0.22, animations: {
      self.dim.alpha = 0
      self.panel.transform = CGAffineTransform(translationX: 0, y: self.panel.bounds.height)
    }, completion: { _ in
      self.removeFromSuperview()
      done?()
      self.onGone?()
      self.onGone = nil
    })
  }

  @objc private func tapDim() {
    let cb = onClose
    dismiss { cb?() }
  }

  @objc private func onPan(_ g: UIPanGestureRecognizer) {
    let ty = max(0, g.translation(in: self).y)
    switch g.state {
    case .changed:
      panel.transform = CGAffineTransform(translationX: 0, y: ty)
    case .ended, .cancelled:
      if ty > 120 || g.velocity(in: self).y > 900 { tapDim() } else {
        UIView.animate(withDuration: 0.2) { self.panel.transform = .identity }
      }
    default: break
    }
  }
}

// MARK: - Bandeja de figurinhas

final class SSStickerTray: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  var onTool: ((String) -> Void)?
  var onEmoji: ((String) -> Void)?
  private let opts: SSOptions
  private var tiles: [UIButton] = []
  private let grid: UICollectionView
  private let isVideo: Bool

  init(opts: SSOptions, isVideo: Bool) {
    self.opts = opts
    self.isVideo = isVideo
    let lay = UICollectionViewFlowLayout()
    lay.minimumInteritemSpacing = 0
    lay.minimumLineSpacing = 4
    grid = UICollectionView(frame: .zero, collectionViewLayout: lay)
    super.init(frame: .zero)
    let tools: [(String, String, String)] = [
      ("mention", "at", opts.t("mention", "Menção")),
      ("location", "mappin.and.ellipse", opts.t("location", "Local")),
      ("link", "link", opts.t("link", "Link")),
      ("poll", "chart.bar.xaxis", opts.t("poll", "Enquete")),
      ("question", "questionmark.bubble", opts.t("question", "Pergunta")),
      ("countdown", "timer", opts.t("countdown", "Contagem")),
      ("music", "music.note", opts.t("music", "Música")),
    ]
    for (key, sym, label) in tools {
      let b = UIButton(type: .custom)
      b.backgroundColor = .white
      b.layer.cornerRadius = 12
      b.setImage(ssSymbol(sym, 14, .bold)?.withTintColor(.black, renderingMode: .alwaysOriginal), for: .normal)
      b.setTitle(" " + label, for: .normal)
      b.setTitleColor(.black, for: .normal)
      b.titleLabel?.font = .systemFont(ofSize: 13, weight: .heavy)
      b.titleLabel?.adjustsFontSizeToFitWidth = true
      b.titleLabel?.minimumScaleFactor = 0.7
      b.accessibilityLabel = label
      b.addAction(UIAction { [weak self] _ in self?.onTool?(key) }, for: .touchUpInside)
      addSubview(b)
      tiles.append(b)
    }
    grid.backgroundColor = .clear
    grid.dataSource = self
    grid.delegate = self
    grid.register(SSEmojiCell.self, forCellWithReuseIdentifier: "e")
    grid.alwaysBounceVertical = true
    addSubview(grid)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    let cols = 4
    let gap: CGFloat = 8
    let tw = (W - 28 - gap * CGFloat(cols - 1)) / CGFloat(cols)
    for (i, b) in tiles.enumerated() {
      let r = i / cols
      let c = i % cols
      b.frame = CGRect(x: 14 + CGFloat(c) * (tw + gap), y: 6 + CGFloat(r) * 48, width: tw, height: 40)
    }
    let rows = (tiles.count + cols - 1) / cols
    let gy = 6 + CGFloat(rows) * 48 + 8
    grid.frame = CGRect(x: 8, y: gy, width: W - 16, height: max(0, bounds.height - gy))
    grid.collectionViewLayout.invalidateLayout()
  }

  func collectionView(_ cv: UICollectionView, numberOfItemsInSection s: Int) -> Int { return opts.emojis.count }

  func collectionView(_ cv: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
    let c = cv.dequeueReusableCell(withReuseIdentifier: "e", for: ip) as! SSEmojiCell
    c.label.text = opts.emojis[ip.item]
    return c
  }

  func collectionView(_ cv: UICollectionView, layout l: UICollectionViewLayout, sizeForItemAt ip: IndexPath) -> CGSize {
    let w = floor(cv.bounds.width / 6)
    return CGSize(width: w, height: w)
  }

  func collectionView(_ cv: UICollectionView, didSelectItemAt ip: IndexPath) {
    onEmoji?(opts.emojis[ip.item])
  }
}

final class SSEmojiCell: UICollectionViewCell {
  let label = UILabel()
  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = .systemFont(ofSize: 36)
    label.textAlignment = .center
    contentView.addSubview(label)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }
  override func layoutSubviews() { super.layoutSubviews(); label.frame = contentView.bounds }
  override var isHighlighted: Bool { didSet { contentView.alpha = isHighlighted ? 0.5 : 1 } }
}

// MARK: - Lista com busca (menção / música)

struct SSRow {
  let title: String
  let subtitle: String
  let image: String          // url (capa) ou ""
  let symbol: String
  let payload: Int
}

final class SSListSheetContent: UIView, UITableViewDataSource, UITableViewDelegate, UITextFieldDelegate {
  let titleLabel = UILabel()
  let field = UITextField()
  let table = UITableView(frame: .zero, style: .plain)
  let empty = UILabel()
  let spinner = UIActivityIndicatorView(style: .medium)
  var rows: [SSRow] = [] { didSet { table.reloadData(); empty.isHidden = !rows.isEmpty || spinner.isAnimating } }
  var onQuery: ((String) -> Void)?
  var onPick: ((SSRow) -> Void)?
  private var debounce: Timer?
  var debounceSec: TimeInterval = 0

  init(title: String, placeholder: String, emptyText: String) {
    super.init(frame: .zero)
    titleLabel.text = title
    titleLabel.textColor = .white
    titleLabel.font = .systemFont(ofSize: 16, weight: .bold)
    titleLabel.textAlignment = .center
    addSubview(titleLabel)
    field.backgroundColor = ssFieldBg
    field.layer.cornerRadius = 12
    field.textColor = .white
    field.tintColor = .white
    field.font = .systemFont(ofSize: 16)
    field.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.45)])
    let lv = UIImageView(image: ssSymbol("magnifyingglass", 14, .semibold))
    lv.tintColor = UIColor(white: 1, alpha: 0.55)
    lv.contentMode = .center
    lv.frame = CGRect(x: 0, y: 0, width: 36, height: 40)
    field.leftView = lv
    field.leftViewMode = .always
    field.clearButtonMode = .whileEditing
    field.returnKeyType = .search
    field.autocorrectionType = .no
    field.keyboardAppearance = .dark
    field.delegate = self
    field.addTarget(self, action: #selector(changed), for: .editingChanged)
    addSubview(field)
    table.backgroundColor = .clear
    table.separatorColor = UIColor(white: 1, alpha: 0.08)
    table.dataSource = self
    table.delegate = self
    table.keyboardDismissMode = .onDrag
    table.register(SSListCell.self, forCellReuseIdentifier: "r")
    table.rowHeight = 60
    addSubview(table)
    empty.text = emptyText
    empty.textColor = UIColor(white: 1, alpha: 0.5)
    empty.font = .systemFont(ofSize: 14, weight: .medium)
    empty.textAlignment = .center
    empty.isHidden = true
    addSubview(empty)
    spinner.color = .white
    spinner.hidesWhenStopped = true
    addSubview(spinner)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    titleLabel.frame = CGRect(x: 16, y: 0, width: W - 32, height: 26)
    field.frame = CGRect(x: 14, y: 34, width: W - 28, height: 42)
    table.frame = CGRect(x: 0, y: 84, width: W, height: max(0, bounds.height - 84))
    empty.frame = CGRect(x: 20, y: 110, width: W - 40, height: 40)
    spinner.center = CGPoint(x: W / 2, y: 130)
  }

  @objc private func changed() {
    debounce?.invalidate()
    let q = field.text ?? ""
    if debounceSec <= 0 { onQuery?(q); return }
    debounce = Timer.scheduledTimer(withTimeInterval: debounceSec, repeats: false) { [weak self] _ in self?.onQuery?(q) }
  }

  func textFieldShouldReturn(_ tf: UITextField) -> Bool {
    debounce?.invalidate()
    onQuery?(tf.text ?? "")
    tf.resignFirstResponder()
    return true
  }

  func tableView(_ tv: UITableView, numberOfRowsInSection s: Int) -> Int { return rows.count }

  func tableView(_ tv: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
    let c = tv.dequeueReusableCell(withIdentifier: "r", for: ip) as! SSListCell
    c.configure(rows[ip.row])
    return c
  }

  func tableView(_ tv: UITableView, didSelectRowAt ip: IndexPath) {
    tv.deselectRow(at: ip, animated: true)
    onPick?(rows[ip.row])
  }
}

final class SSListCell: UITableViewCell {
  private let icon = UIImageView()
  private let thumb = UIImageView()
  private let t1 = UILabel()
  private let t2 = UILabel()
  private var url = ""

  override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
    super.init(style: style, reuseIdentifier: reuseIdentifier)
    backgroundColor = .clear
    let sel = UIView()
    sel.backgroundColor = UIColor(white: 1, alpha: 0.08)
    selectedBackgroundView = sel
    icon.backgroundColor = UIColor(white: 1, alpha: 0.1)
    icon.layer.cornerRadius = 20
    icon.tintColor = .white
    icon.contentMode = .center
    contentView.addSubview(icon)
    thumb.layer.cornerRadius = 8
    thumb.clipsToBounds = true
    thumb.contentMode = .scaleAspectFill
    contentView.addSubview(thumb)
    t1.textColor = .white
    t1.font = .systemFont(ofSize: 15, weight: .semibold)
    contentView.addSubview(t1)
    t2.textColor = UIColor(white: 1, alpha: 0.55)
    t2.font = .systemFont(ofSize: 13)
    contentView.addSubview(t2)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  func configure(_ r: SSRow) {
    t1.text = r.title
    t2.text = r.subtitle
    icon.image = ssSymbol(r.symbol, 15, .semibold)
    thumb.image = nil
    thumb.isHidden = r.image.isEmpty
    url = r.image
    if !r.image.isEmpty, let u = URL(string: r.image) {
      let want = r.image
      URLSession.shared.dataTask(with: u) { [weak self] d, _, _ in
        guard let d = d, let img = UIImage(data: d) else { return }
        DispatchQueue.main.async { if self?.url == want { self?.thumb.image = img } }
      }.resume()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    icon.frame = CGRect(x: 16, y: 10, width: 40, height: 40)
    thumb.frame = icon.frame
    let x: CGFloat = 68
    t1.frame = CGRect(x: x, y: 11, width: contentView.bounds.width - x - 16, height: 20)
    t2.frame = CGRect(x: x, y: 31, width: contentView.bounds.width - x - 16, height: 18)
  }
}

// MARK: - Formulário com prévia ao vivo (enquete, pergunta, contagem, link, local)

final class SSFormOverlay: UIView, UITextFieldDelegate {
  private let dim = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
  private let cancelBtn = UIButton(type: .system)
  private let doneBtn = UIButton(type: .custom)
  private let previewHost = UIView()
  private var preview: UIView?
  private(set) var fields: [UITextField] = []
  let datePicker = UIDatePicker()
  private var hasDate = false
  private let extraBtn = UIButton(type: .system)
  var keyboardInset: CGFloat = 0 { didSet { setNeedsLayout(); UIView.animate(withDuration: 0.25) { self.layoutIfNeeded() } } }
  var onDone: (() -> Void)?
  var onCancel: (() -> Void)?
  var onChange: (() -> Void)?
  var onExtra: (() -> Void)?
  var validate: (() -> Bool)?

  init(opts: SSOptions, placeholders: [String], values: [String], date: Date?, extra: String?) {
    super.init(frame: .zero)
    addSubview(dim)
    cancelBtn.setTitle(opts.t("cancel", "Cancelar"), for: .normal)
    cancelBtn.setTitleColor(.white, for: .normal)
    cancelBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
    cancelBtn.addAction(UIAction { [weak self] _ in self?.endEditing(true); self?.onCancel?() }, for: .touchUpInside)
    addSubview(cancelBtn)
    doneBtn.setTitle(opts.t("done", "Concluir"), for: .normal)
    doneBtn.setTitleColor(.black, for: .normal)
    doneBtn.backgroundColor = .white
    doneBtn.layer.cornerRadius = 18
    doneBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
    doneBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
    doneBtn.addAction(UIAction { [weak self] _ in
      guard let self = self else { return }
      if let v = self.validate, !v() { ssHaptic("warn"); return }
      self.endEditing(true)
      self.onDone?()
    }, for: .touchUpInside)
    addSubview(doneBtn)
    previewHost.isUserInteractionEnabled = false
    addSubview(previewHost)
    for (i, ph) in placeholders.enumerated() {
      let f = UITextField()
      f.backgroundColor = ssFieldBg
      f.layer.cornerRadius = 12
      f.textColor = .white
      f.tintColor = .white
      f.font = .systemFont(ofSize: 16, weight: .medium)
      f.attributedPlaceholder = NSAttributedString(string: ph, attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.45)])
      f.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 10))
      f.leftViewMode = .always
      f.clearButtonMode = .whileEditing
      f.keyboardAppearance = .dark
      f.returnKeyType = i == placeholders.count - 1 ? .done : .next
      f.text = i < values.count ? values[i] : ""
      f.delegate = self
      f.tag = i
      f.addAction(UIAction { [weak self] _ in self?.onChange?() }, for: .editingChanged)
      addSubview(f)
      fields.append(f)
    }
    if let d = date {
      hasDate = true
      datePicker.datePickerMode = .dateAndTime
      if #available(iOS 14.0, *) { datePicker.preferredDatePickerStyle = .wheels }
      datePicker.minimumDate = Date().addingTimeInterval(60)
      datePicker.date = d
      datePicker.overrideUserInterfaceStyle = .dark
      datePicker.tintColor = .white
      datePicker.addAction(UIAction { [weak self] _ in self?.onChange?() }, for: .valueChanged)
      addSubview(datePicker)
    }
    if let e = extra {
      extraBtn.setImage(ssSymbol("location.fill", 13, .semibold), for: .normal)
      extraBtn.setTitle(" " + e, for: .normal)
      extraBtn.tintColor = .white
      extraBtn.setTitleColor(.white, for: .normal)
      extraBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
      extraBtn.backgroundColor = UIColor(white: 1, alpha: 0.12)
      extraBtn.layer.cornerRadius = 17
      extraBtn.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
      extraBtn.addAction(UIAction { [weak self] _ in self?.onExtra?() }, for: .touchUpInside)
      addSubview(extraBtn)
    } else {
      extraBtn.isHidden = true
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  func setPreview(_ v: UIView?, size: CGSize) {
    preview?.removeFromSuperview()
    preview = v
    previewSize = size
    guard let v = v else { return }
    v.transform = .identity
    v.frame = CGRect(origin: .zero, size: size)
    previewHost.addSubview(v)
    setNeedsLayout()
  }

  private var previewSize: CGSize = .zero

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    let safe = safeAreaInsets
    dim.frame = bounds
    cancelBtn.frame = CGRect(x: 12, y: safe.top + 8, width: 100, height: 36)
    cancelBtn.contentHorizontalAlignment = .left
    let dw = max(96, doneBtn.intrinsicContentSize.width)
    doneBtn.frame = CGRect(x: W - 14 - dw, y: safe.top + 8, width: dw, height: 36)
    let bottom = bounds.height - max(safe.bottom, keyboardInset) - 12
    var y = bottom
    if hasDate && keyboardInset <= 0 {
      y -= 180
      datePicker.frame = CGRect(x: 14, y: y, width: W - 28, height: 180)
      y -= 8
    } else if hasDate {
      datePicker.frame = CGRect(x: 14, y: bounds.height + 20, width: W - 28, height: 180)
    }
    if !extraBtn.isHidden {
      y -= 36
      let ew = min(W - 28, extraBtn.intrinsicContentSize.width + 8)
      extraBtn.frame = CGRect(x: (W - ew) / 2, y: y, width: ew, height: 34)
      y -= 10
    }
    for f in fields.reversed() {
      y -= 46
      f.frame = CGRect(x: 14, y: y, width: W - 28, height: 46)
      y -= 8
    }
    let top = safe.top + 56
    let avail = max(40, y - top)
    previewHost.frame = CGRect(x: 0, y: top, width: W, height: avail)
    if let v = preview, previewSize.width > 0 {
      let k = min(1, min((W - 40) / previewSize.width, (avail - 10) / max(1, previewSize.height)))
      v.transform = .identity
      v.bounds = CGRect(origin: .zero, size: previewSize)
      v.center = CGPoint(x: W / 2, y: avail / 2)
      v.transform = CGAffineTransform(scaleX: k, y: k)
    }
  }

  func textFieldShouldReturn(_ tf: UITextField) -> Bool {
    if tf.tag + 1 < fields.count { fields[tf.tag + 1].becomeFirstResponder() } else { tf.resignFirstResponder() }
    return true
  }
}

// MARK: - Público

final class SSAudienceContent: UIView {
  var onPick: ((String) -> Void)?
  var onEdit: ((String) -> Void)?
  private let title = UILabel()
  private var rows: [UIControl] = []
  private let warn = UILabel()
  private let keys = ["all", "contacts", "close_friends", "except"]

  init(opts: SSOptions, selected: String, closeFriendsCount: Int, exceptCount: Int) {
    super.init(frame: .zero)
    title.text = opts.t("audienceTitle", "Quem pode ver")
    title.textColor = .white
    title.font = .systemFont(ofSize: 17, weight: .bold)
    title.textAlignment = .center
    addSubview(title)
    let meta: [String: (String, String, String)] = [
      "all": ("globe", opts.t("audAll", "Todos"), opts.t("audAllSub", "Seus contatos e conversas")),
      "contacts": ("person.2", opts.t("audContacts", "Meus contatos"), opts.t("audContactsSub", "Só quem está na sua agenda")),
      "close_friends": ("star", opts.t("audClose", "Melhores amigos"), opts.t("audCloseSub", "Anel verde, só a sua lista")),
      "except": ("eye.slash", opts.t("audExcept", "Ocultar de…"), opts.t("audExceptSub", "Todos, menos quem você escolher")),
    ]
    for k in keys {
      guard let m = meta[k] else { continue }
      let r = UIControl()
      let ic = UIImageView(image: ssSymbol(m.0, 17, .semibold))
      ic.tintColor = .white
      ic.contentMode = .center
      ic.backgroundColor = UIColor(white: 1, alpha: 0.1)
      ic.layer.cornerRadius = 20
      ic.tag = 1
      r.addSubview(ic)
      let t1 = UILabel()
      t1.text = m.1
      t1.textColor = .white
      t1.font = .systemFont(ofSize: 16, weight: .semibold)
      t1.tag = 2
      r.addSubview(t1)
      let t2 = UILabel()
      var sub = m.2
      if k == "except" && exceptCount > 0 { sub = "\(sub) · \(exceptCount)" }
      if k == "close_friends" && closeFriendsCount > 0 { sub = "\(sub) · \(closeFriendsCount)" }
      t2.text = sub
      t2.textColor = UIColor(white: 1, alpha: 0.55)
      t2.font = .systemFont(ofSize: 13)
      t2.tag = 3
      r.addSubview(t2)
      let check = UIImageView(image: ssSymbol(k == selected ? "checkmark.circle.fill" : "circle", 22, .regular))
      check.tintColor = k == selected ? .white : UIColor(white: 1, alpha: 0.35)
      check.tag = 4
      r.addSubview(check)
      if k == "close_friends" || k == "except" {
        let e = UIButton(type: .system)
        e.setTitle(opts.t("audEdit", "Editar"), for: .normal)
        e.setTitleColor(.white, for: .normal)
        e.titleLabel?.font = .systemFont(ofSize: 13, weight: .bold)
        e.backgroundColor = UIColor(white: 1, alpha: 0.12)
        e.layer.cornerRadius = 14
        e.tag = 5
        e.addAction(UIAction { [weak self] _ in self?.onEdit?(k) }, for: .touchUpInside)
        r.addSubview(e)
      }
      r.accessibilityLabel = m.1
      r.accessibilityTraits = k == selected ? [.button, .selected] : .button
      r.addAction(UIAction { [weak self] _ in self?.onPick?(k) }, for: .touchUpInside)
      addSubview(r)
      rows.append(r)
    }
    warn.text = opts.t("closeFriendsEmpty", "Sua lista está vazia. Toque em Editar para adicionar pessoas.")
    warn.textColor = UIColor(white: 1, alpha: 0.75)
    warn.font = .systemFont(ofSize: 13, weight: .medium)
    warn.numberOfLines = 2
    warn.textAlignment = .center
    warn.isHidden = !(selected == "close_friends" && closeFriendsCount == 0)
    addSubview(warn)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    title.frame = CGRect(x: 16, y: 0, width: W - 32, height: 26)
    var y: CGFloat = 38
    for r in rows {
      r.frame = CGRect(x: 0, y: y, width: W, height: 62)
      r.viewWithTag(1)?.frame = CGRect(x: 16, y: 11, width: 40, height: 40)
      let hasEdit = r.viewWithTag(5) != nil
      let right: CGFloat = hasEdit ? 140 : 60
      r.viewWithTag(2)?.frame = CGRect(x: 68, y: 12, width: W - 68 - right, height: 20)
      r.viewWithTag(3)?.frame = CGRect(x: 68, y: 32, width: W - 68 - right, height: 18)
      r.viewWithTag(4)?.frame = CGRect(x: W - 46, y: 18, width: 26, height: 26)
      r.viewWithTag(5)?.frame = CGRect(x: W - 46 - 76, y: 17, width: 68, height: 28)
      y += 62
    }
    warn.frame = CGRect(x: 20, y: y + 4, width: W - 40, height: 36)
  }
}
