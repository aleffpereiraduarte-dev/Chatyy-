import UIKit

// [2026-10-18 profile-edit-native] "Editar perfil" NATIVO estilo Telegram, por
// cima da MESMA view ChatyyChatInfo (apiVersion 4). Tocar "Editar" no perfil
// próprio troca a tela para o modo edição: barra Cancelar … Concluído, foto
// com "Definir nova foto", cartões agrupados com campos de texto reais (Nome +
// Sobrenome num cartão, Bio com contador, Usuário → subtela com @ e checagem
// de disponibilidade, Pronomes, Link, Recado com pílulas, Foto de capa,
// grupos de linhas de contato/privacidade).
//
// Os campos são do NATIVO enquanto a edição está aberta (o JS não reescreve o
// texto a cada tecla): o JS só manda os valores iniciais (`values`, relidos
// quando `seq` muda) e recebe tudo por onEdit:
//   {type:"change", field, value}   a cada edição (dirty / checagem do @)
//   {type:"done", values}            Concluído (JS valida + salva)
//   {type:"cancel", dirty}           Cancelar (JS pergunta "Descartar?")
//   {type:"avatar"} {type:"cover"} {type:"coverRemove"} {type:"row", id}
// Prop `edit` (contrato):
//   {on, seq, backSeq, values {first,last,bio,username,pronouns,link,about},
//    pic {u,a,i,g}, cover {u,a}, busyAvatar, busyCover, saving,
//    errors {first,bio,username,pronouns,link,about,general},
//    uname {q, state: "checking"|"ok"|"bad"|"", text}, presets [..],
//    groups [{header, footer, rows [{id, title, val, nav, dest}]}],
//    labels {..}, limits {..}}
// Mesmo contrato no Android (CIEditPanel.kt).

struct CIEditRow: Equatable {
  var id = ""
  var title = ""
  var value = ""
  var chevron = true
  var destructive = false

  init(_ d: [String: Any]) {
    id = CLVal.str(d["id"])
    title = CLVal.str(d["title"])
    value = CLVal.str(d["val"])
    chevron = d["nav"] == nil ? true : CLVal.bool(d["nav"])
    destructive = CLVal.bool(d["dest"])
  }
}

struct CIEditGroup: Equatable {
  var header = ""
  var footer = ""
  var rows: [CIEditRow] = []

  init(_ d: [String: Any]) {
    header = CLVal.str(d["header"])
    footer = CLVal.str(d["footer"])
    if let arr = d["rows"] as? [Any] {
      for x in arr {
        guard let m = x as? [String: Any] else { continue }
        let r = CIEditRow(m)
        if !r.id.isEmpty { rows.append(r) }
      }
    }
  }
}

struct CIEditState: Equatable {
  var on = false
  var seq = 0
  var backSeq = 0
  var values: [String: String] = [:]
  var pic = CIPic()
  var coverURL = ""
  var coverAuth = false
  var busyAvatar = false
  var busyCover = false
  var saving = false
  var errors: [String: String] = [:]
  var unameQ = ""
  var unameState = ""
  var unameText = ""
  var presets: [String] = []
  var groups: [CIEditGroup] = []
  var labels: [String: String] = [:]
  var limits: [String: Int] = [:]

  init() {}

  init(_ d: [String: Any]?) {
    guard let d = d else { return }
    on = CLVal.bool(d["on"])
    seq = CLVal.int(d["seq"])
    backSeq = CLVal.int(d["backSeq"])
    if let v = d["values"] as? [String: Any] {
      for (k, x) in v { values[k] = CLVal.str(x) }
    }
    pic = CIPic(d["pic"])
    if let c = d["cover"] as? [String: Any] {
      coverURL = CLVal.str(c["u"])
      coverAuth = CLVal.bool(c["a"])
    }
    busyAvatar = CLVal.bool(d["busyAvatar"])
    busyCover = CLVal.bool(d["busyCover"])
    saving = CLVal.bool(d["saving"])
    if let e = d["errors"] as? [String: Any] {
      for (k, x) in e {
        let s = CLVal.str(x)
        if !s.isEmpty { errors[k] = s }
      }
    }
    if let u = d["uname"] as? [String: Any] {
      unameQ = CLVal.str(u["q"])
      unameState = CLVal.str(u["state"])
      unameText = CLVal.str(u["text"])
    }
    if let arr = d["presets"] as? [Any] {
      for x in arr {
        let s = CLVal.str(x)
        if !s.isEmpty && !presets.contains(s) { presets.append(s) }
      }
    }
    if let arr = d["groups"] as? [Any] {
      for x in arr {
        guard let m = x as? [String: Any] else { continue }
        let g = CIEditGroup(m)
        if !g.rows.isEmpty { groups.append(g) }
      }
    }
    if let l = d["labels"] as? [String: Any] {
      for (k, x) in l {
        let s = CLVal.str(x)
        if !s.isEmpty { labels[k] = s }
      }
    }
    if let l = d["limits"] as? [String: Any] {
      for (k, x) in l {
        let n = CLVal.int(x)
        if n > 0 { limits[k] = n }
      }
    }
  }

  func label(_ k: String, _ fb: String) -> String { return labels[k] ?? fb }
  func limit(_ k: String, _ fb: Int) -> Int { return limits[k] ?? fb }
}

/// Linha de toque do cartão de edição (título · valor · miniatura · seta).
final class CIEditNavRow: UIControl {
  let titleLabel = UILabel()
  let valueLabel = UILabel()
  let thumb = UIImageView()
  let chevron = UIImageView()
  let spinner = UIActivityIndicatorView(style: .medium)
  var rowId = ""
  private var pressColor = UIColor.clear
  private var thumbURL = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    titleLabel.numberOfLines = 1
    titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    titleLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
    valueLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    valueLabel.textAlignment = .right
    valueLabel.numberOfLines = 1
    valueLabel.lineBreakMode = .byTruncatingTail
    valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    valueLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    thumb.contentMode = .scaleAspectFill
    thumb.clipsToBounds = true
    thumb.layer.cornerRadius = 4
    thumb.layer.cornerCurve = .continuous
    thumb.isHidden = true
    chevron.image = UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold))
    chevron.contentMode = .center
    chevron.setContentHuggingPriority(.required, for: .horizontal)
    chevron.setContentCompressionResistancePriority(.required, for: .horizontal)
    spinner.hidesWhenStopped = true

    let h = UIStackView(arrangedSubviews: [titleLabel, valueLabel, thumb, spinner, chevron])
    h.axis = .horizontal
    h.alignment = .center
    h.spacing = 8
    h.isUserInteractionEnabled = false
    h.translatesAutoresizingMaskIntoConstraints = false
    addSubview(h)
    NSLayoutConstraint.activate([
      h.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      h.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      h.centerYAnchor.constraint(equalTo: centerYAnchor),
      heightAnchor.constraint(equalToConstant: 50),
      thumb.widthAnchor.constraint(equalToConstant: 66),
      thumb.heightAnchor.constraint(equalToConstant: 22),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(title: String, value: String, chevronOn: Bool, destructive: Bool, palette p: STPalette) {
    titleLabel.text = title
    titleLabel.textColor = destructive ? p.destructive : p.text
    valueLabel.text = value
    valueLabel.textColor = p.secondary
    valueLabel.isHidden = value.isEmpty
    chevron.isHidden = !chevronOn
    chevron.tintColor = p.tertiary
    spinner.color = p.secondary
    pressColor = p.press
    accessibilityLabel = value.isEmpty ? title : title + ", " + value
  }

  func setThumb(_ url: String, auth: Bool) {
    if url.isEmpty {
      thumbURL = ""
      thumb.image = nil
      thumb.isHidden = true
      return
    }
    thumb.isHidden = false
    if url == thumbURL && thumb.image != nil { return }
    thumbURL = url
    if let img = CLImageLoader.shared.cachedImage(url, maxPixel: 240) {
      thumb.image = img
      return
    }
    thumb.image = nil
    CLImageLoader.shared.load(url, auth: auth, maxPixel: 240) { [weak self] img in
      guard let self = self, self.thumbURL == url else { return }
      self.thumb.image = img
    }
  }

  override var isHighlighted: Bool {
    didSet { backgroundColor = isHighlighted ? pressColor : .clear }
  }
}

/// Pílula de recado pronto (Disponível / Ocupado / …).
final class CIEditPill: UIControl {
  let label = UILabel()
  var title = ""
  private var selectedLook = false
  private var palette = STPalette(dark: false)

  override init(frame: CGRect) {
    super.init(frame: frame)
    layer.cornerRadius = 16
    layer.cornerCurve = .continuous
    layer.borderWidth = 1
    label.font = UIFont.systemFont(ofSize: 15, weight: .medium)
    label.isUserInteractionEnabled = false
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
      heightAnchor.constraint(equalToConstant: 32),
    ])
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ t: String, selected: Bool, palette p: STPalette) {
    title = t
    label.text = t
    selectedLook = selected
    palette = p
    accessibilityLabel = t
    accessibilityTraits = selected ? [.button, .selected] : .button
    paint()
  }

  private func paint() {
    if selectedLook {
      backgroundColor = palette.text
      layer.borderColor = palette.text.cgColor
      label.textColor = palette.cardBg
    } else {
      backgroundColor = isHighlighted ? palette.press : palette.chipBg
      layer.borderColor = UIColor.clear.cgColor
      label.textColor = palette.chipFg
    }
  }

  override var isHighlighted: Bool {
    didSet { paint() }
  }
}

final class CIEditPanel: UIView, UITextFieldDelegate, UITextViewDelegate {
  var onEvent: (([String: Any]) -> Void)?

  private var state = CIEditState()
  private var palette = STPalette(dark: false)
  private var appliedSeq = Int.min
  private var appliedBack = Int.min
  private var shown = false
  private var initial: [String: String] = [:]
  private var localErrors: [String: String] = [:]
  private var bottomInset: CGFloat = 0
  private var keyboardInset: CGFloat = 0
  private weak var activeView: UIView?
  private var subOpen = false
  private var groupsApplied: [CIEditGroup] = []
  private var pillsApplied: [String] = []

  private let mainView = UIView()
  private let navBar = UIView()
  private let navLine = UIView()
  private let cancelButton = UIButton(type: .system)
  private let doneButton = UIButton(type: .system)
  private let navTitle = UILabel()
  private let doneSpinner = UIActivityIndicatorView(style: .medium)
  private let scroll = UIScrollView()
  private let stack = UIStackView()

  // Foto
  private let avatarBox = UIControl()
  private let avatar = CIAvatarView()
  private let avatarDim = UIView()
  private let avatarSpinner = UIActivityIndicatorView(style: .medium)
  private let setPhotoButton = UIButton(type: .system)
  private let generalError = UILabel()

  // Nome
  private let firstField = UITextField()
  private let lastField = UITextField()
  private let nameError = UILabel()
  private let nameFooter = UILabel()

  // Bio
  private let bioView = UITextView()
  private let bioPlaceholder = UILabel()
  private let bioCounter = UILabel()
  private let bioError = UILabel()
  private let bioFooter = UILabel()

  // Usuário / Pronomes / Link
  private let usernameRow = CIEditNavRow()
  private let pronounsTitle = UILabel()
  private let pronounsField = UITextField()
  private let linkTitle = UILabel()
  private let linkField = UITextField()
  private let detailsError = UILabel()

  // Recado
  private let aboutTitle = UILabel()
  private let aboutField = UITextField()
  private let pillsScroll = UIScrollView()
  private let pillsStack = UIStackView()
  private var pills: [CIEditPill] = []
  private let aboutError = UILabel()
  private let aboutFooter = UILabel()

  // Capa
  private let coverRow = CIEditNavRow()
  private let coverRemoveRow = CIEditNavRow()
  private var coverRemoveSep: UIView?

  // Grupos (contato / privacidade / mais)
  private let groupsStack = UIStackView()
  private var groupRows: [CIEditNavRow] = []

  // Subtela do @usuário
  private let subView = UIView()
  private let subNav = UIView()
  private let subLine = UIView()
  private let subBack = UIButton(type: .system)
  private let subDone = UIButton(type: .system)
  private let subTitle = UILabel()
  private let subScroll = UIScrollView()
  private let subStack = UIStackView()
  private let atLabel = UILabel()
  private let unameField = UITextField()
  private let unameStatus = UILabel()
  private let unameSpinner = UIActivityIndicatorView(style: .medium)
  private let unameFooter = UILabel()
  private var unameStatusLeading: NSLayoutConstraint?

  // Pintura
  private var cards: [UIView] = []
  private var separators: [UIView] = []
  private var footers: [UILabel] = []
  private var errorLabels: [UILabel] = []
  private var fieldTitles: [UILabel] = []
  private var fields: [UITextField] = []
  private var navBars: [UIView] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    isHidden = true
    alpha = 0
    build()
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Construção

  private func pin(_ v: UIView, to p: UIView) {
    v.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      v.leadingAnchor.constraint(equalTo: p.leadingAnchor),
      v.trailingAnchor.constraint(equalTo: p.trailingAnchor),
      v.topAnchor.constraint(equalTo: p.topAnchor),
      v.bottomAnchor.constraint(equalTo: p.bottomAnchor),
    ])
  }

  private func makeNav(_ bar: UIView, line: UIView, left: UIButton, right: UIButton, title: UILabel, spinner: UIActivityIndicatorView?) {
    navBars.append(bar)
    left.titleLabel?.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    right.titleLabel?.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
    title.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
    title.textAlignment = .center
    title.lineBreakMode = .byTruncatingTail
    title.accessibilityTraits = .header
    for v in [left, right, title, line] as [UIView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      bar.addSubview(v)
    }
    let px = 1 / max(1, UIScreen.main.scale)
    let centerTitle = title.centerXAnchor.constraint(equalTo: bar.centerXAnchor)
    centerTitle.priority = .defaultHigh
    var cs: [NSLayoutConstraint] = [
      bar.heightAnchor.constraint(equalToConstant: CIHeaderOverlay.navH),
      left.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 8),
      left.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
      left.heightAnchor.constraint(equalToConstant: 44),
      left.widthAnchor.constraint(greaterThanOrEqualToConstant: 60),
      right.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -8),
      right.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
      right.heightAnchor.constraint(equalToConstant: 44),
      right.widthAnchor.constraint(greaterThanOrEqualToConstant: 60),
      centerTitle,
      title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
      title.leadingAnchor.constraint(greaterThanOrEqualTo: left.trailingAnchor, constant: 8),
      title.trailingAnchor.constraint(lessThanOrEqualTo: right.leadingAnchor, constant: -8),
      line.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
      line.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
      line.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
      line.heightAnchor.constraint(equalToConstant: px),
    ]
    if let sp = spinner {
      sp.hidesWhenStopped = true
      sp.translatesAutoresizingMaskIntoConstraints = false
      bar.addSubview(sp)
      cs.append(sp.centerXAnchor.constraint(equalTo: right.centerXAnchor))
      cs.append(sp.centerYAnchor.constraint(equalTo: right.centerYAnchor))
    }
    NSLayoutConstraint.activate(cs)
    line.alpha = 0
  }

  private func makeScroll(_ sv: UIScrollView, stack st: UIStackView, in parent: UIView, below bar: UIView) {
    sv.translatesAutoresizingMaskIntoConstraints = false
    sv.alwaysBounceVertical = true
    sv.keyboardDismissMode = .interactive
    sv.contentInsetAdjustmentBehavior = .never
    sv.delegate = self
    parent.addSubview(sv)
    st.axis = .vertical
    st.spacing = 28
    st.translatesAutoresizingMaskIntoConstraints = false
    sv.addSubview(st)
    let fill = st.widthAnchor.constraint(equalTo: sv.frameLayoutGuide.widthAnchor, constant: -32)
    fill.priority = UILayoutPriority(999)
    NSLayoutConstraint.activate([
      sv.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
      sv.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
      sv.topAnchor.constraint(equalTo: bar.bottomAnchor),
      sv.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
      st.topAnchor.constraint(equalTo: sv.contentLayoutGuide.topAnchor, constant: 8),
      st.bottomAnchor.constraint(equalTo: sv.contentLayoutGuide.bottomAnchor, constant: -8),
      st.centerXAnchor.constraint(equalTo: sv.frameLayoutGuide.centerXAnchor),
      fill,
      st.widthAnchor.constraint(lessThanOrEqualToConstant: 640),
    ])
  }

  private func makeCard(_ rows: [UIView]) -> UIView {
    let card = UIView()
    card.layer.cornerRadius = 14
    card.layer.cornerCurve = .continuous
    card.clipsToBounds = true
    let v = UIStackView()
    v.axis = .vertical
    card.addSubview(v)
    pin(v, to: card)
    for (i, r) in rows.enumerated() {
      if i > 0 { v.addArrangedSubview(makeSeparator()) }
      v.addArrangedSubview(r)
    }
    cards.append(card)
    return card
  }

  private func makeSeparator() -> UIView {
    let wrap = UIView()
    let line = UIView()
    line.translatesAutoresizingMaskIntoConstraints = false
    wrap.addSubview(line)
    let px = 1 / max(1, UIScreen.main.scale)
    NSLayoutConstraint.activate([
      wrap.heightAnchor.constraint(equalToConstant: px),
      line.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 16),
      line.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
      line.topAnchor.constraint(equalTo: wrap.topAnchor),
      line.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
    ])
    separators.append(line)
    line.backgroundColor = palette.separator
    return wrap
  }

  /// Rótulo de rodapé/erro com recuo de 16 pt (fica oculto quando vazio).
  private func caption(_ l: UILabel, error: Bool) -> UIView {
    l.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    l.numberOfLines = 0
    let wrap = UIView()
    l.translatesAutoresizingMaskIntoConstraints = false
    wrap.addSubview(l)
    NSLayoutConstraint.activate([
      l.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 16),
      l.trailingAnchor.constraint(equalTo: wrap.trailingAnchor, constant: -16),
      l.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 8),
      l.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
    ])
    if error { errorLabels.append(l) } else { footers.append(l) }
    wrap.isHidden = true
    return wrap
  }

  private func group(_ views: [UIView]) -> UIStackView {
    let g = UIStackView(arrangedSubviews: views)
    g.axis = .vertical
    g.spacing = 0
    return g
  }

  private func setupField(_ f: UITextField, tag: Int) {
    f.tag = tag
    f.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    f.delegate = self
    f.clearButtonMode = .whileEditing
    f.addTarget(self, action: #selector(fieldChanged(_:)), for: .editingChanged)
    fields.append(f)
  }

  /// Linha "Título  [campo]" de 50 pt (Pronomes / Link / Recado).
  private func titledFieldRow(_ title: UILabel, _ f: UITextField) -> UIView {
    let row = UIView()
    title.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    title.setContentCompressionResistancePriority(.required, for: .horizontal)
    title.setContentHuggingPriority(.required, for: .horizontal)
    fieldTitles.append(title)
    title.translatesAutoresizingMaskIntoConstraints = false
    f.translatesAutoresizingMaskIntoConstraints = false
    f.textAlignment = .right
    row.addSubview(title)
    row.addSubview(f)
    NSLayoutConstraint.activate([
      row.heightAnchor.constraint(equalToConstant: 50),
      title.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
      title.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      title.widthAnchor.constraint(greaterThanOrEqualToConstant: 96),
      f.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 12),
      f.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
      f.topAnchor.constraint(equalTo: row.topAnchor),
      f.bottomAnchor.constraint(equalTo: row.bottomAnchor),
    ])
    return row
  }

  private func plainFieldRow(_ f: UITextField) -> UIView {
    let row = UIView()
    f.translatesAutoresizingMaskIntoConstraints = false
    row.addSubview(f)
    NSLayoutConstraint.activate([
      row.heightAnchor.constraint(equalToConstant: 50),
      f.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
      f.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
      f.topAnchor.constraint(equalTo: row.topAnchor),
      f.bottomAnchor.constraint(equalTo: row.bottomAnchor),
    ])
    return row
  }

  private func build() {
    addSubview(mainView)
    pin(mainView, to: self)

    // Barra: Cancelar … Concluído
    navBar.translatesAutoresizingMaskIntoConstraints = false
    mainView.addSubview(navBar)
    NSLayoutConstraint.activate([
      navBar.leadingAnchor.constraint(equalTo: mainView.leadingAnchor),
      navBar.trailingAnchor.constraint(equalTo: mainView.trailingAnchor),
      navBar.topAnchor.constraint(equalTo: mainView.topAnchor),
    ])
    makeNav(navBar, line: navLine, left: cancelButton, right: doneButton, title: navTitle, spinner: doneSpinner)
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
    makeScroll(scroll, stack: stack, in: mainView, below: navBar)

    // ── Foto + "Definir nova foto" ──
    let header = UIView()
    avatarBox.translatesAutoresizingMaskIntoConstraints = false
    avatar.translatesAutoresizingMaskIntoConstraints = false
    avatar.maxPixel = 480
    avatarDim.translatesAutoresizingMaskIntoConstraints = false
    avatarDim.backgroundColor = UIColor(white: 0, alpha: 0.4)
    avatarDim.layer.cornerRadius = 50
    avatarDim.isUserInteractionEnabled = false
    avatarDim.isHidden = true
    avatarSpinner.translatesAutoresizingMaskIntoConstraints = false
    avatarSpinner.color = .white
    avatarSpinner.hidesWhenStopped = true
    avatarBox.addSubview(avatar)
    avatarBox.addSubview(avatarDim)
    avatarBox.addSubview(avatarSpinner)
    avatarBox.addTarget(self, action: #selector(avatarTapped), for: .touchUpInside)
    avatarBox.isAccessibilityElement = true
    avatarBox.accessibilityTraits = [.button, .image]
    header.addSubview(avatarBox)
    setPhotoButton.translatesAutoresizingMaskIntoConstraints = false
    setPhotoButton.titleLabel?.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    setPhotoButton.addTarget(self, action: #selector(avatarTapped), for: .touchUpInside)
    header.addSubview(setPhotoButton)
    NSLayoutConstraint.activate([
      avatarBox.topAnchor.constraint(equalTo: header.topAnchor, constant: 12),
      avatarBox.centerXAnchor.constraint(equalTo: header.centerXAnchor),
      avatarBox.widthAnchor.constraint(equalToConstant: 100),
      avatarBox.heightAnchor.constraint(equalToConstant: 100),
      avatar.leadingAnchor.constraint(equalTo: avatarBox.leadingAnchor),
      avatar.trailingAnchor.constraint(equalTo: avatarBox.trailingAnchor),
      avatar.topAnchor.constraint(equalTo: avatarBox.topAnchor),
      avatar.bottomAnchor.constraint(equalTo: avatarBox.bottomAnchor),
      avatarDim.leadingAnchor.constraint(equalTo: avatarBox.leadingAnchor),
      avatarDim.trailingAnchor.constraint(equalTo: avatarBox.trailingAnchor),
      avatarDim.topAnchor.constraint(equalTo: avatarBox.topAnchor),
      avatarDim.bottomAnchor.constraint(equalTo: avatarBox.bottomAnchor),
      avatarSpinner.centerXAnchor.constraint(equalTo: avatarBox.centerXAnchor),
      avatarSpinner.centerYAnchor.constraint(equalTo: avatarBox.centerYAnchor),
      setPhotoButton.topAnchor.constraint(equalTo: avatarBox.bottomAnchor, constant: 10),
      setPhotoButton.centerXAnchor.constraint(equalTo: header.centerXAnchor),
      setPhotoButton.heightAnchor.constraint(equalToConstant: 36),
      setPhotoButton.bottomAnchor.constraint(equalTo: header.bottomAnchor),
    ])
    let generalWrap = caption(generalError, error: true)
    generalError.textAlignment = .center
    stack.addArrangedSubview(group([header, generalWrap]))

    // ── Nome + Sobrenome (um cartão, Telegram) ──
    setupField(firstField, tag: 1)
    setupField(lastField, tag: 2)
    firstField.autocapitalizationType = .words
    lastField.autocapitalizationType = .words
    firstField.textContentType = .givenName
    lastField.textContentType = .familyName
    firstField.returnKeyType = .next
    lastField.returnKeyType = .done
    let nameCard = makeCard([plainFieldRow(firstField), plainFieldRow(lastField)])
    stack.addArrangedSubview(group([nameCard, caption(nameError, error: true), caption(nameFooter, error: false)]))

    // ── Bio com contador ──
    let bioRow = UIView()
    bioView.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    bioView.isScrollEnabled = false
    bioView.backgroundColor = .clear
    bioView.textContainerInset = UIEdgeInsets(top: 14, left: 0, bottom: 14, right: 0)
    bioView.textContainer.lineFragmentPadding = 0
    bioView.delegate = self
    bioView.translatesAutoresizingMaskIntoConstraints = false
    bioPlaceholder.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    bioPlaceholder.isUserInteractionEnabled = false
    bioPlaceholder.translatesAutoresizingMaskIntoConstraints = false
    bioCounter.font = UIFont.monospacedDigitSystemFont(ofSize: 15, weight: .regular)
    bioCounter.textAlignment = .right
    bioCounter.translatesAutoresizingMaskIntoConstraints = false
    bioCounter.setContentCompressionResistancePriority(.required, for: .horizontal)
    bioCounter.setContentHuggingPriority(.required, for: .horizontal)
    bioRow.addSubview(bioView)
    bioRow.addSubview(bioPlaceholder)
    bioRow.addSubview(bioCounter)
    NSLayoutConstraint.activate([
      bioView.leadingAnchor.constraint(equalTo: bioRow.leadingAnchor, constant: 16),
      bioView.trailingAnchor.constraint(equalTo: bioCounter.leadingAnchor, constant: -8),
      bioView.topAnchor.constraint(equalTo: bioRow.topAnchor),
      bioView.bottomAnchor.constraint(equalTo: bioRow.bottomAnchor),
      bioView.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
      bioPlaceholder.leadingAnchor.constraint(equalTo: bioView.leadingAnchor),
      bioPlaceholder.trailingAnchor.constraint(lessThanOrEqualTo: bioView.trailingAnchor),
      bioPlaceholder.topAnchor.constraint(equalTo: bioView.topAnchor, constant: 14),
      bioCounter.trailingAnchor.constraint(equalTo: bioRow.trailingAnchor, constant: -16),
      bioCounter.topAnchor.constraint(equalTo: bioRow.topAnchor, constant: 15),
    ])
    let bioCard = makeCard([bioRow])
    stack.addArrangedSubview(group([bioCard, caption(bioError, error: true), caption(bioFooter, error: false)]))

    // ── Usuário (subtela) · Pronomes · Link ──
    usernameRow.addTarget(self, action: #selector(usernameTapped), for: .touchUpInside)
    setupField(pronounsField, tag: 5)
    setupField(linkField, tag: 6)
    pronounsField.autocapitalizationType = .none
    pronounsField.returnKeyType = .done
    linkField.keyboardType = .URL
    linkField.autocapitalizationType = .none
    linkField.autocorrectionType = .no
    linkField.textContentType = .URL
    linkField.returnKeyType = .done
    let detailsCard = makeCard([usernameRow, titledFieldRow(pronounsTitle, pronounsField), titledFieldRow(linkTitle, linkField)])
    stack.addArrangedSubview(group([detailsCard, caption(detailsError, error: true)]))

    // ── Recado + pílulas ──
    setupField(aboutField, tag: 7)
    aboutField.returnKeyType = .done
    let aboutRow = titledFieldRow(aboutTitle, aboutField)
    let pillsRow = UIView()
    pillsScroll.translatesAutoresizingMaskIntoConstraints = false
    pillsScroll.showsHorizontalScrollIndicator = false
    pillsScroll.alwaysBounceHorizontal = true
    pillsStack.axis = .horizontal
    pillsStack.spacing = 8
    pillsStack.alignment = .center
    pillsStack.translatesAutoresizingMaskIntoConstraints = false
    pillsRow.addSubview(pillsScroll)
    pillsScroll.addSubview(pillsStack)
    NSLayoutConstraint.activate([
      pillsRow.heightAnchor.constraint(equalToConstant: 52),
      pillsScroll.leadingAnchor.constraint(equalTo: pillsRow.leadingAnchor),
      pillsScroll.trailingAnchor.constraint(equalTo: pillsRow.trailingAnchor),
      pillsScroll.topAnchor.constraint(equalTo: pillsRow.topAnchor),
      pillsScroll.bottomAnchor.constraint(equalTo: pillsRow.bottomAnchor),
      pillsStack.leadingAnchor.constraint(equalTo: pillsScroll.contentLayoutGuide.leadingAnchor, constant: 16),
      pillsStack.trailingAnchor.constraint(equalTo: pillsScroll.contentLayoutGuide.trailingAnchor, constant: -16),
      pillsStack.topAnchor.constraint(equalTo: pillsScroll.contentLayoutGuide.topAnchor),
      pillsStack.bottomAnchor.constraint(equalTo: pillsScroll.contentLayoutGuide.bottomAnchor),
      pillsStack.heightAnchor.constraint(equalTo: pillsScroll.frameLayoutGuide.heightAnchor),
    ])
    let aboutCard = makeCard([aboutRow, pillsRow])
    stack.addArrangedSubview(group([aboutCard, caption(aboutError, error: true), caption(aboutFooter, error: false)]))

    // ── Foto de capa ──
    coverRow.addTarget(self, action: #selector(coverTapped), for: .touchUpInside)
    coverRemoveRow.addTarget(self, action: #selector(coverRemoveTapped), for: .touchUpInside)
    let coverCard = makeCard([coverRow, coverRemoveRow])
    if let inner = coverCard.subviews.first as? UIStackView, inner.arrangedSubviews.count == 3 {
      coverRemoveSep = inner.arrangedSubviews[1]
    }
    stack.addArrangedSubview(coverCard)

    // ── Grupos do JS (contato, privacidade, mais) ──
    groupsStack.axis = .vertical
    groupsStack.spacing = 28
    stack.addArrangedSubview(groupsStack)

    buildSub()
  }

  private func buildSub() {
    subView.isHidden = true
    addSubview(subView)
    pin(subView, to: self)
    subNav.translatesAutoresizingMaskIntoConstraints = false
    subView.addSubview(subNav)
    NSLayoutConstraint.activate([
      subNav.leadingAnchor.constraint(equalTo: subView.leadingAnchor),
      subNav.trailingAnchor.constraint(equalTo: subView.trailingAnchor),
      subNav.topAnchor.constraint(equalTo: subView.topAnchor),
    ])
    makeNav(subNav, line: subLine, left: subBack, right: subDone, title: subTitle, spinner: nil)
    subBack.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
    subBack.contentHorizontalAlignment = .leading
    subBack.addTarget(self, action: #selector(subBackTapped), for: .touchUpInside)
    subDone.addTarget(self, action: #selector(subBackTapped), for: .touchUpInside)
    makeScroll(subScroll, stack: subStack, in: subView, below: subNav)

    let row = UIView()
    atLabel.text = "@"
    atLabel.font = UIFont.systemFont(ofSize: 17, weight: .regular)
    atLabel.setContentHuggingPriority(.required, for: .horizontal)
    atLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
    atLabel.translatesAutoresizingMaskIntoConstraints = false
    setupField(unameField, tag: 4)
    unameField.autocapitalizationType = .none
    unameField.autocorrectionType = .no
    unameField.spellCheckingType = .no
    unameField.keyboardType = .asciiCapable
    unameField.textContentType = .username
    unameField.returnKeyType = .done
    unameField.translatesAutoresizingMaskIntoConstraints = false
    row.addSubview(atLabel)
    row.addSubview(unameField)
    NSLayoutConstraint.activate([
      row.heightAnchor.constraint(equalToConstant: 50),
      atLabel.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 16),
      atLabel.centerYAnchor.constraint(equalTo: row.centerYAnchor),
      unameField.leadingAnchor.constraint(equalTo: atLabel.trailingAnchor, constant: 2),
      unameField.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -16),
      unameField.topAnchor.constraint(equalTo: row.topAnchor),
      unameField.bottomAnchor.constraint(equalTo: row.bottomAnchor),
    ])
    let card = makeCard([row])

    // Situação do @ (verificando / disponível / em uso) com indicador.
    let statusWrap = UIView()
    unameStatus.font = UIFont.systemFont(ofSize: 13, weight: .regular)
    unameStatus.numberOfLines = 0
    unameStatus.translatesAutoresizingMaskIntoConstraints = false
    unameSpinner.hidesWhenStopped = true
    unameSpinner.translatesAutoresizingMaskIntoConstraints = false
    unameSpinner.transform = CGAffineTransform(scaleX: 0.75, y: 0.75)
    statusWrap.addSubview(unameSpinner)
    statusWrap.addSubview(unameStatus)
    let lead = unameStatus.leadingAnchor.constraint(equalTo: statusWrap.leadingAnchor, constant: 16)
    unameStatusLeading = lead
    NSLayoutConstraint.activate([
      unameSpinner.leadingAnchor.constraint(equalTo: statusWrap.leadingAnchor, constant: 10),
      unameSpinner.centerYAnchor.constraint(equalTo: unameStatus.centerYAnchor),
      lead,
      unameStatus.trailingAnchor.constraint(equalTo: statusWrap.trailingAnchor, constant: -16),
      unameStatus.topAnchor.constraint(equalTo: statusWrap.topAnchor, constant: 8),
      unameStatus.bottomAnchor.constraint(equalTo: statusWrap.bottomAnchor),
    ])
    statusWrap.isHidden = true
    statusWrap.tag = 901
    subStack.addArrangedSubview(group([card, statusWrap, caption(unameFooter, error: false)]))
  }

  // MARK: - Props

  func configure(_ s: CIEditState, palette p: STPalette, bottomInset b: CGFloat) {
    state = s
    palette = p
    bottomInset = b
    applyColors()
    applyLabels()
    if s.seq != appliedSeq {
      appliedSeq = s.seq
      hydrate()
    }
    if appliedBack == Int.min {
      appliedBack = s.backSeq
    } else if s.backSeq != appliedBack {
      appliedBack = s.backSeq
      if shown { handleBack() }
    }
    rebuildPills()
    rebuildGroups()
    applyDynamic()
    setShown(s.on)
    refreshInsets()
  }

  private func applyColors() {
    let p = palette
    backgroundColor = p.pageBg
    mainView.backgroundColor = p.pageBg
    subView.backgroundColor = p.pageBg
    for b in navBars { b.backgroundColor = p.pageBg }
    navLine.backgroundColor = p.separator
    subLine.backgroundColor = p.separator
    for c in [cancelButton, doneButton, subBack, subDone, setPhotoButton] { c.tintColor = p.text; c.setTitleColor(p.text, for: .normal); c.setTitleColor(p.secondary, for: .disabled) }
    navTitle.textColor = p.text
    subTitle.textColor = p.text
    doneSpinner.color = p.secondary
    unameSpinner.color = p.secondary
    for c in cards { c.backgroundColor = p.cardBg }
    for s in separators { s.backgroundColor = p.separator }
    for l in footers { l.textColor = p.secondary }
    for l in errorLabels { l.textColor = p.destructive }
    for l in fieldTitles { l.textColor = p.text }
    atLabel.textColor = p.secondary
    let caret = p.text
    for f in fields {
      f.textColor = p.text
      f.tintColor = caret
      f.keyboardAppearance = p.dark ? .dark : .light
    }
    bioView.textColor = p.text
    bioView.tintColor = caret
    bioView.keyboardAppearance = p.dark ? .dark : .light
    bioPlaceholder.textColor = placeholderColor
    scroll.indicatorStyle = p.dark ? .white : .black
    subScroll.indicatorStyle = p.dark ? .white : .black
  }

  private var placeholderColor: UIColor {
    return palette.dark ? UIColor(white: 1, alpha: 0.32) : UIColor(red: 60 / 255, green: 60 / 255, blue: 67 / 255, alpha: 0.32)
  }

  private func placeholder(_ f: UITextField, _ text: String) {
    f.attributedPlaceholder = NSAttributedString(string: text, attributes: [.foregroundColor: placeholderColor])
  }

  private func applyLabels() {
    let s = state
    cancelButton.setTitle(s.label("cancel", "Cancelar"), for: .normal)
    doneButton.setTitle(s.label("done", "Concluído"), for: .normal)
    navTitle.text = s.label("title", "")
    setPhotoButton.setTitle(s.label("setPhoto", "Definir nova foto"), for: .normal)
    avatarBox.accessibilityLabel = s.label("setPhoto", "Definir nova foto")
    placeholder(firstField, s.label("firstPh", "Nome (obrigatório)"))
    placeholder(lastField, s.label("lastPh", "Sobrenome (opcional)"))
    setCaption(nameFooter, s.label("nameFooter", ""))
    bioPlaceholder.text = s.label("bioPh", "Bio")
    setCaption(bioFooter, s.label("bioHint", "Você pode adicionar algumas linhas sobre você."))
    pronounsTitle.text = s.label("pronouns", "Pronomes")
    placeholder(pronounsField, s.label("pronounsPh", "ela/dela"))
    linkTitle.text = s.label("link", "Link")
    placeholder(linkField, s.label("linkPh", "https://"))
    aboutTitle.text = s.label("about", "Recado")
    placeholder(aboutField, s.label("aboutPh", "Disponível"))
    setCaption(aboutFooter, s.label("aboutHint", ""))
    subTitle.text = s.label("usernameTitle", "Nome de usuário")
    subBack.setTitle(" " + s.label("back", "Voltar"), for: .normal)
    subDone.setTitle(s.label("done", "Concluído"), for: .normal)
    placeholder(unameField, s.label("usernamePh", "usuario"))
    setCaption(unameFooter, s.label("usernameHint", ""))
  }

  private func setCaption(_ l: UILabel, _ text: String) {
    if l.text != text { l.text = text }
    let hide = text.isEmpty
    if let w = l.superview, w.isHidden != hide { w.isHidden = hide }
  }

  // MARK: - Valores

  private static func sanitizeUsername(_ s: String) -> String {
    var out = ""
    for ch in s.lowercased() {
      if ch.isASCII && (ch.isLetter || ch.isNumber || ch == "_" || ch == ".") { out.append(ch) }
    }
    if out.count > 30 { out = String(out.prefix(30)) }
    return out
  }

  private func hydrate() {
    let v = state.values
    initial = [:]
    for k in ["first", "last", "bio", "username", "pronouns", "link", "about"] { initial[k] = v[k] ?? "" }
    initial["username"] = CIEditPanel.sanitizeUsername(initial["username"] ?? "")
    firstField.text = initial["first"]
    lastField.text = initial["last"]
    bioView.text = initial["bio"]
    unameField.text = initial["username"]
    pronounsField.text = initial["pronouns"]
    linkField.text = initial["link"]
    aboutField.text = initial["about"]
    localErrors = [:]
    closeSub(animated: false)
    scroll.setContentOffset(CGPoint(x: 0, y: -scroll.contentInset.top), animated: false)
  }

  private func currentValues() -> [String: String] {
    return [
      "first": firstField.text ?? "",
      "last": lastField.text ?? "",
      "bio": bioView.text ?? "",
      "username": CIEditPanel.sanitizeUsername(unameField.text ?? ""),
      "pronouns": pronounsField.text ?? "",
      "link": linkField.text ?? "",
      "about": aboutField.text ?? "",
    ]
  }

  private func isDirty() -> Bool {
    let cur = currentValues()
    for (k, v) in cur where (initial[k] ?? "") != v { return true }
    return false
  }

  private func key(for f: UITextField) -> String {
    switch f.tag {
    case 1: return "first"
    case 2: return "last"
    case 4: return "username"
    case 5: return "pronouns"
    case 6: return "link"
    case 7: return "about"
    default: return ""
    }
  }

  private func maxLen(_ key: String) -> Int {
    switch key {
    case "first", "last": return state.limit(key, 40)
    case "bio": return state.limit("bio", 150)
    case "username": return state.limit("username", 30)
    case "pronouns": return state.limit("pronouns", 40)
    case "link": return state.limit("link", 120)
    case "about": return state.limit("about", 139)
    default: return 500
    }
  }

  private func err(_ k: String) -> String {
    if let e = localErrors[k], !e.isEmpty { return e }
    return state.errors[k] ?? ""
  }

  private func emit(_ ev: [String: Any]) {
    onEvent?(ev)
  }

  // MARK: - Estado dinâmico

  private func applyDynamic() {
    let s = state
    let p = palette
    avatar.configure(s.pic)
    avatarDim.isHidden = !s.busyAvatar
    if s.busyAvatar { avatarSpinner.startAnimating() } else { avatarSpinner.stopAnimating() }
    avatarBox.isEnabled = !s.busyAvatar && !s.saving
    setPhotoButton.isEnabled = !s.busyAvatar && !s.saving

    doneButton.isHidden = s.saving
    if s.saving { doneSpinner.startAnimating() } else { doneSpinner.stopAnimating() }
    cancelButton.isEnabled = !s.saving
    let busyFields = s.saving
    for f in fields { f.isEnabled = !busyFields }
    bioView.isEditable = !busyFields

    setCaption(generalError, err("general"))
    let nameErr = err("first").isEmpty ? err("last") : err("first")
    setCaption(nameError, nameErr)
    setCaption(bioError, err("bio"))
    var det = err("username")
    if det.isEmpty { det = err("pronouns") }
    if det.isEmpty { det = err("link") }
    setCaption(detailsError, det)
    setCaption(aboutError, err("about"))

    refreshBio()
    let u = CIEditPanel.sanitizeUsername(unameField.text ?? "")
    usernameRow.configure(title: s.label("username", "Usuário"), value: u.isEmpty ? s.label("usernameEmpty", "") : "@" + u, chevronOn: true, destructive: false, palette: p)
    refreshUname()
    refreshPillSelection()

    let hasCover = !s.coverURL.isEmpty
    coverRow.configure(title: s.label("cover", "Foto de capa"), value: hasCover ? s.label("coverChange", "Alterar") : s.label("coverAdd", "Adicionar"), chevronOn: true, destructive: false, palette: p)
    coverRow.setThumb(s.coverURL, auth: s.coverAuth)
    if s.busyCover { coverRow.spinner.startAnimating() } else { coverRow.spinner.stopAnimating() }
    coverRow.isEnabled = !s.busyCover && !s.saving
    coverRemoveRow.configure(title: s.label("coverRemove", "Remover foto de capa"), value: "", chevronOn: false, destructive: true, palette: p)
    coverRemoveRow.isHidden = !hasCover
    coverRemoveSep?.isHidden = !hasCover
    coverRemoveRow.isEnabled = !s.busyCover && !s.saving
  }

  private func refreshBio() {
    let text = bioView.text ?? ""
    bioPlaceholder.isHidden = !text.isEmpty
    let left = maxLen("bio") - (text as NSString).length
    bioCounter.text = String(max(0, left))
    bioCounter.textColor = left <= 10 ? palette.destructive : palette.secondary
  }

  private func refreshUname() {
    let s = state
    let u = CIEditPanel.sanitizeUsername(unameField.text ?? "")
    let wrap = subStack.viewWithTag(901)
    var text = ""
    var color = palette.secondary
    var spin = false
    let e = err("username")
    if !e.isEmpty {
      text = e
      color = palette.destructive
    } else if u.isEmpty || u == (initial["username"] ?? "") {
      text = ""
    } else if u.count < 3 {
      text = s.label("usernameShort", "Mínimo de 3 caracteres.")
      color = palette.destructive
    } else if s.unameQ == u {
      text = s.unameText
      switch s.unameState {
      case "checking":
        spin = true
      case "ok":
        color = palette.text
      case "bad":
        color = palette.destructive
      default:
        break
      }
    } else {
      text = s.label("usernameChecking", "Verificando…")
      spin = true
    }
    unameStatus.text = text
    unameStatus.textColor = color
    if spin { unameSpinner.startAnimating() } else { unameSpinner.stopAnimating() }
    // Indicador ocupa o recuo: o texto anda 14 pt quando gira.
    unameStatusLeading?.constant = spin ? 34 : 16
    let hide = text.isEmpty
    if let w = wrap, w.isHidden != hide { w.isHidden = hide }
  }

  private func rebuildPills() {
    if state.presets == pillsApplied { return }
    pillsApplied = state.presets
    for v in pills { v.removeFromSuperview() }
    pills = []
    for t in state.presets {
      let pill = CIEditPill()
      pill.addTarget(self, action: #selector(pillTapped(_:)), for: .touchUpInside)
      pill.configure(t, selected: false, palette: palette)
      pillsStack.addArrangedSubview(pill)
      pills.append(pill)
    }
    if let row = pillsScroll.superview { row.isHidden = pills.isEmpty }
  }

  private func refreshPillSelection() {
    let cur = (aboutField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    for pill in pills { pill.configure(pill.title, selected: pill.title == cur, palette: palette) }
  }

  private func rebuildGroups() {
    if state.groups == groupsApplied {
      return
    }
    groupsApplied = state.groups
    for v in groupsStack.arrangedSubviews {
      groupsStack.removeArrangedSubview(v)
      v.removeFromSuperview()
    }
    groupRows = []
    let p = palette
    for g in state.groups {
      var views: [UIView] = []
      if !g.header.isEmpty {
        let h = UILabel()
        h.text = g.header.uppercased()
        h.font = UIFont.systemFont(ofSize: 13, weight: .regular)
        h.textColor = p.header
        h.numberOfLines = 1
        let wrap = UIView()
        h.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(h)
        NSLayoutConstraint.activate([
          h.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: 16),
          h.trailingAnchor.constraint(equalTo: wrap.trailingAnchor, constant: -16),
          h.topAnchor.constraint(equalTo: wrap.topAnchor),
          h.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -8),
        ])
        views.append(wrap)
      }
      var rows: [UIView] = []
      for r in g.rows {
        let row = CIEditNavRow()
        row.rowId = r.id
        row.configure(title: r.title, value: r.value, chevronOn: r.chevron, destructive: r.destructive, palette: p)
        row.addTarget(self, action: #selector(groupRowTapped(_:)), for: .touchUpInside)
        groupRows.append(row)
        rows.append(row)
      }
      let card = makeCard(rows)
      card.backgroundColor = p.cardBg
      views.append(card)
      if !g.footer.isEmpty {
        let f = UILabel()
        let wrap = caption(f, error: false)
        f.text = g.footer
        f.textColor = p.secondary
        wrap.isHidden = false
        views.append(wrap)
      }
      groupsStack.addArrangedSubview(group(views))
    }
    groupsStack.isHidden = state.groups.isEmpty
  }

  // MARK: - Mostrar / esconder

  private func setShown(_ on: Bool) {
    if on == shown { return }
    shown = on
    if on {
      isHidden = false
      alpha = 0
      mainView.transform = CGAffineTransform(translationX: 0, y: 14)
      UIView.animate(withDuration: 0.24, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
        self.alpha = 1
        self.mainView.transform = .identity
      }
      UISelectionFeedbackGenerator().selectionChanged()
    } else {
      endEditing(true)
      UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseIn]) {
        self.alpha = 0
      } completion: { _ in
        if !self.shown {
          self.isHidden = true
          self.closeSub(animated: false)
        }
      }
    }
  }

  private func handleBack() {
    if subOpen { closeSub(animated: true) } else { cancelTapped() }
  }

  private func openSub() {
    if subOpen || state.saving { return }
    subOpen = true
    endEditing(true)
    refreshUname()
    let w = max(1, bounds.width)
    subView.isHidden = false
    subView.transform = CGAffineTransform(translationX: w, y: 0)
    UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
      self.subView.transform = .identity
      self.mainView.transform = CGAffineTransform(translationX: -w * 0.3, y: 0)
    } completion: { _ in
      if self.subOpen { self.unameField.becomeFirstResponder() }
    }
  }

  private func closeSub(animated: Bool) {
    if !subOpen {
      subView.isHidden = true
      return
    }
    subOpen = false
    unameField.resignFirstResponder()
    applyDynamic()
    let w = max(1, bounds.width)
    if !animated {
      subView.transform = .identity
      subView.isHidden = true
      mainView.transform = .identity
      return
    }
    UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [.allowUserInteraction]) {
      self.subView.transform = CGAffineTransform(translationX: w, y: 0)
      self.mainView.transform = .identity
    } completion: { _ in
      if !self.subOpen {
        self.subView.isHidden = true
        self.subView.transform = .identity
      }
    }
  }

  // MARK: - Ações

  @objc private func cancelTapped() {
    if state.saving { return }
    if subOpen { closeSub(animated: true); return }
    endEditing(true)
    emit(["type": "cancel", "dirty": isDirty()])
  }

  @objc private func doneTapped() {
    if state.saving { return }
    if subOpen { closeSub(animated: true) }
    endEditing(true)
    localErrors = [:]
    let v = currentValues()
    let full = ((v["first"] ?? "") + (v["last"] ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
    if full.isEmpty { localErrors["first"] = state.label("errName", "Informe seu nome.") }
    let u = v["username"] ?? ""
    if !u.isEmpty && u.count < 3 { localErrors["username"] = state.label("usernameShort", "Mínimo de 3 caracteres.") }
    if !localErrors.isEmpty {
      UINotificationFeedbackGenerator().notificationOccurred(.error)
      applyDynamic()
      let target: UIView = localErrors["first"] != nil ? (firstField as UIView) : (usernameRow as UIView)
      DispatchQueue.main.async { [weak self] in self?.ensureVisible(target) }
      return
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    emit(["type": "done", "values": v])
  }

  @objc private func avatarTapped() {
    if state.busyAvatar || state.saving { return }
    endEditing(true)
    emit(["type": "avatar"])
  }

  @objc private func usernameTapped() { openSub() }

  @objc private func subBackTapped() { closeSub(animated: true) }

  @objc private func coverTapped() {
    if state.busyCover || state.saving { return }
    endEditing(true)
    emit(["type": "cover"])
  }

  @objc private func coverRemoveTapped() {
    if state.busyCover || state.saving { return }
    endEditing(true)
    emit(["type": "coverRemove"])
  }

  @objc private func groupRowTapped(_ sender: CIEditNavRow) {
    if state.saving { return }
    endEditing(true)
    emit(["type": "row", "id": sender.rowId])
  }

  @objc private func pillTapped(_ sender: CIEditPill) {
    if state.saving { return }
    UISelectionFeedbackGenerator().selectionChanged()
    aboutField.text = sender.title
    localErrors["about"] = nil
    refreshPillSelection()
    emit(["type": "change", "field": "about", "value": sender.title])
  }

  @objc private func fieldChanged(_ f: UITextField) {
    let k = key(for: f)
    if k.isEmpty { return }
    if k == "username" {
      let raw = f.text ?? ""
      let clean = CIEditPanel.sanitizeUsername(raw.hasPrefix("@") ? String(raw.dropFirst()) : raw)
      if clean != raw { f.text = clean }
    }
    if localErrors[k] != nil {
      localErrors[k] = nil
    }
    let value = k == "username" ? CIEditPanel.sanitizeUsername(f.text ?? "") : (f.text ?? "")
    emit(["type": "change", "field": k, "value": value])
    if k == "about" { refreshPillSelection() }
    if k == "username" {
      refreshUname()
      let s = state
      usernameRow.configure(title: s.label("username", "Usuário"), value: value.isEmpty ? s.label("usernameEmpty", "") : "@" + value, chevronOn: true, destructive: false, palette: palette)
    }
    if k == "first" || k == "last" { setCaption(nameError, err("first").isEmpty ? err("last") : err("first")) }
  }

  // MARK: - UITextFieldDelegate / UITextViewDelegate

  func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
    let k = key(for: textField)
    if k.isEmpty { return true }
    let cur = (textField.text ?? "") as NSString
    if range.location == NSNotFound || range.location + range.length > cur.length { return true }
    let next = cur.replacingCharacters(in: range, with: string) as NSString
    return next.length <= maxLen(k) || next.length < cur.length
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    if textField === firstField {
      lastField.becomeFirstResponder()
    } else if textField === unameField {
      closeSub(animated: true)
    } else {
      textField.resignFirstResponder()
    }
    return true
  }

  func textFieldDidBeginEditing(_ textField: UITextField) {
    activeView = textField
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak textField] in
      if let f = textField { self?.ensureVisible(f) }
    }
  }

  func textFieldDidEndEditing(_ textField: UITextField) {
    if activeView === textField { activeView = nil }
  }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    let cur = (textView.text ?? "") as NSString
    if range.location == NSNotFound || range.location + range.length > cur.length { return true }
    let next = cur.replacingCharacters(in: range, with: text) as NSString
    return next.length <= maxLen("bio") || next.length < cur.length
  }

  func textViewDidChange(_ textView: UITextView) {
    localErrors["bio"] = nil
    refreshBio()
    emit(["type": "change", "field": "bio", "value": textView.text ?? ""])
    DispatchQueue.main.async { [weak self] in self?.ensureCaretVisible() }
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    activeView = textView
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.ensureCaretVisible() }
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    if activeView === textView { activeView = nil }
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if scrollView === scroll {
      let a: CGFloat = scrollView.contentOffset.y + scrollView.contentInset.top > 4 ? 1 : 0
      if navLine.alpha != a { navLine.alpha = a }
    } else if scrollView === subScroll {
      let a: CGFloat = scrollView.contentOffset.y + scrollView.contentInset.top > 4 ? 1 : 0
      if subLine.alpha != a { subLine.alpha = a }
    }
  }

  // MARK: - Teclado

  private func ensureVisible(_ v: UIView) {
    guard v.window != nil else { return }
    let sv = v.isDescendant(of: subView) ? subScroll : scroll
    let r = v.convert(v.bounds, to: sv).insetBy(dx: 0, dy: -20)
    sv.scrollRectToVisible(r, animated: true)
  }

  private func ensureCaretVisible() {
    guard bioView.window != nil, let range = bioView.selectedTextRange else {
      ensureVisible(bioView)
      return
    }
    let caret = bioView.caretRect(for: range.end)
    if caret.isNull || caret.isInfinite {
      ensureVisible(bioView)
      return
    }
    let r = bioView.convert(caret, to: scroll).insetBy(dx: 0, dy: -28)
    scroll.scrollRectToVisible(r, animated: true)
  }

  @objc private func keyboardChanged(_ n: Notification) {
    guard let win = window else { return }
    if n.name == UIResponder.keyboardWillHideNotification {
      keyboardInset = 0
    } else if let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue {
      let mine = convert(bounds, to: win)
      keyboardInset = max(0, mine.maxY - end.minY)
    }
    refreshInsets()
    if keyboardInset > 0, let a = activeView {
      if a === bioView { ensureCaretVisible() } else { ensureVisible(a) }
    }
  }

  private func refreshInsets() {
    let b = max(bottomInset, keyboardInset) + 24
    for sv in [scroll, subScroll] {
      if sv.contentInset.bottom != b {
        var ins = sv.contentInset
        ins.bottom = b
        sv.contentInset = ins
        var ind = sv.verticalScrollIndicatorInsets
        ind.bottom = max(0, b - 24)
        sv.verticalScrollIndicatorInsets = ind
      }
    }
  }
}
