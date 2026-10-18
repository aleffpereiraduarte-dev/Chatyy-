import UIKit

// [2026-10-14 native-home] Prévia (peek) do toque longo: cabeçalho com avatar
// + nome e as últimas mensagens em balões. Abre na hora com a última prévia
// da linha; o JS responde ao onPeekRequest com as mensagens do cache local
// (prop `peek`) e a prévia se completa sem fechar.
// [2026-10-17 peek-fit] (print do founder: prévia alta empurrava o menu para
// fora da tela — sumiam Bloquear/Reportar/Apagar):
//   • altura MÁXIMA = min(45% da tela, tela − áreas seguras − menu estimado)
//     → o menu do UIContextMenu sempre cabe inteiro;
// [2026-10-17 peek-fixed] (prints do founder: uma prévia alta com várias
// mensagens, outra baixinha com 1 balão): a altura vinha do CONTEÚDO
// (min(máx, conteúdo)) e o teto dependia do menu DAQUELA linha (fixada /
// bloquear mudam o nº de itens). Agora é igual ao WhatsApp: cartão SEMPRE do
// mesmo tamanho = fração fixa da tela (padrão 42%, prop JS `peekHeight`),
// limitada pelo PIOR caso de menu (não o da linha) → idêntico em toda
// conversa; mensagens ancoradas embaixo e espaço vazio em cima quando são
// poucas; o tamanho não muda quando o JS completa a prévia.
//   • mostra as ÚLTIMAS mensagens ancoradas embaixo, com fade no topo quando
//     há mais conteúdo acima;
//   • mídia com miniatura real (foto/vídeo/GIF/figurinha: `u` = arquivo local,
//     thumb ou CDN que o JS já resolveu), hora em todas e recibo ✓/✓✓/azul.
// Item do JS: {m: minha, t: texto (rótulo p/ binário antigo), h: hora,
//   s: remetente (grupo), r: 1 enviado / 2 entregue / 3 lido,
//   k: "image"|"video"|"gif"|"sticker" (opcional), u: uri da miniatura,
//   c: legenda (só mídia), w/h2: dimensões (opcional)}.
struct CLPeekMessage {
  let mine: Bool
  let text: String
  let time: String
  let sender: String
  var receipt: Int = 0
  var kind: String = ""
  var uri: String = ""
  var caption: String = ""
  var w: Double = 0
  var h: Double = 0
  var isMedia: Bool { return !uri.isEmpty && (kind == "image" || kind == "video" || kind == "gif" || kind == "sticker") }
}

final class CLPeekController: UIViewController {
  let convId: String
  private var row: CLRow
  private let theme: CLTheme
  private let menuHeight: CGFloat
  /// Fração da altura da tela p/ o cartão (0 = padrão nativo). Prop JS `peekHeight`.
  private let heightFraction: CGFloat
  private weak var hostWindow: UIWindow?
  private let header = UIView()
  private let avatar = CLAvatarView()
  private let titleLabel = UILabel()
  private let clip = UIView()          // recebe a máscara de fade (não rola)
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private let fade = CAGradientLayer()
  private var messages: [CLPeekMessage] = []
  private static let headerH: CGFloat = 60

  static let defaultHeightFraction: CGFloat = 0.42

  init(row: CLRow, theme: CLTheme, menuHeight: CGFloat = 0, window: UIWindow? = nil, heightFraction: CGFloat = 0) {
    self.convId = row.id
    self.row = row
    self.theme = theme
    self.menuHeight = menuHeight
    self.heightFraction = (heightFraction >= 0.2 && heightFraction <= 0.7) ? heightFraction : CLPeekController.defaultHeightFraction
    self.hostWindow = window
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    // Área das mensagens no tom do fundo da conversa; cabeçalho em vidro.
    view.backgroundColor = theme.dark ? UIColor(clHex: 0x0B0B0B) : UIColor(clHex: 0xEFEFEF)
    header.backgroundColor = theme.dark ? UIColor(clHex: 0x1C1C1E) : UIColor(clHex: 0xF7F7F7)
    view.addSubview(clip)
    view.addSubview(header)
    var r = row
    r.note = ""
    r.online = false
    avatar.configure(r, theme: theme, rowBackground: theme.card)
    avatar.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
    header.addSubview(avatar)
    titleLabel.text = row.title
    titleLabel.textAlignment = .center
    titleLabel.font = UIFont.systemFont(ofSize: 17, weight: .semibold)
    titleLabel.textColor = theme.text
    header.addSubview(titleLabel)
    scroll.alwaysBounceVertical = false
    scroll.showsVerticalScrollIndicator = false
    scroll.isScrollEnabled = false
    clip.addSubview(scroll)
    stack.axis = .vertical
    stack.spacing = 6
    stack.alignment = .fill
    scroll.addSubview(stack)
    fade.colors = [UIColor.clear.cgColor, UIColor.black.cgColor, UIColor.black.cgColor]
    fade.startPoint = CGPoint(x: 0.5, y: 0)
    fade.endPoint = CGPoint(x: 0.5, y: 1)
    if messages.isEmpty { seedFromRow() }
    rebuild()
  }

  private func seedFromRow() {
    let txt = row.locked ? row.text : (row.text.isEmpty ? row.empty : row.text)
    if txt.isEmpty { return }
    let mine = row.receipt > 0 || row.pending || row.failed
    messages = [CLPeekMessage(mine: mine, text: txt, time: row.time, sender: mine ? "" : (row.isGroupish ? row.sender : ""), receipt: row.receipt)]
  }

  func update(_ dict: [String: Any]) {
    guard CLVal.str(dict["id"]) == convId else { return }
    let items = (dict["items"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
    if items.isEmpty { return }
    messages = items.suffix(12).map { (d: [String: Any]) -> CLPeekMessage in
      var m = CLPeekMessage(mine: CLVal.bool(d["m"]), text: CLVal.str(d["t"]), time: CLVal.str(d["h"]), sender: CLVal.str(d["s"]), receipt: CLVal.int(d["r"]))
      m.kind = CLVal.str(d["k"])
      m.uri = CLVal.str(d["u"])
      m.caption = CLVal.str(d["c"])
      m.w = CLVal.double(d["w"])
      m.h = CLVal.double(d["h2"])
      return m
    }
    if isViewLoaded { rebuild() }
  }

  // MARK: - Altura FIXA (igual em toda conversa; menu sempre inteiro)

  /// Altura do cartão: fração fixa da tela, limitada pelo PIOR caso de menu
  /// (`menuHeight` = estimativa máxima, a mesma p/ toda linha) → o mesmo
  /// tamanho em qualquer conversa, independente de quantas mensagens há.
  private func fixedHeight() -> CGFloat {
    var screenH = UIScreen.main.bounds.height
    var insets = UIEdgeInsets(top: 47, left: 0, bottom: 34, right: 0)
    if let w = hostWindow ?? view.window {
      screenH = w.bounds.height
      insets = w.safeAreaInsets
    }
    let usable = screenH - max(insets.top, 20) - max(insets.bottom, 12)
    var h = min(screenH * heightFraction, 560)
    if menuHeight > 0 {
      // 12 pt entre prévia e menu + 12 pt de respiro nas bordas; nunca abaixo
      // de 28% da tela (telas pequenas: o menu do sistema rola).
      h = min(h, max(usable - menuHeight - 24, screenH * 0.28))
    }
    return floor(max(CLPeekController.headerH + 120, h))
  }

  // MARK: - Balões

  private func metaString(_ m: CLPeekMessage, color: UIColor) -> NSAttributedString {
    let a = NSMutableAttributedString()
    if !m.time.isEmpty {
      a.append(NSAttributedString(string: m.time, attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: color]))
    }
    if m.mine, let img = CLReceiptView.image(state: m.receipt, gray: color, read: theme.receiptRead, height: 11) {
      let att = NSTextAttachment()
      att.image = img
      att.bounds = CGRect(x: 0, y: -1, width: img.size.width, height: img.size.height)
      if a.length > 0 { a.append(NSAttributedString(string: " ", attributes: [.font: UIFont.systemFont(ofSize: 11)])) }
      a.append(NSAttributedString(attachment: att))
    }
    return a
  }

  private func bubbleColor(_ m: CLPeekMessage) -> UIColor {
    return m.mine ? (theme.dark ? UIColor(clHex: 0x2C2C2E) : UIColor(clHex: 0x0B0B0B)) : (theme.dark ? UIColor(clHex: 0x1C1C1E) : .white)
  }

  private func place(_ b: UIView, in wrap: UIView, mine: Bool, maxW: CGFloat = 0.8) -> [NSLayoutConstraint] {
    var cons: [NSLayoutConstraint] = [
      b.topAnchor.constraint(equalTo: wrap.topAnchor),
      b.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
      b.widthAnchor.constraint(lessThanOrEqualTo: wrap.widthAnchor, multiplier: maxW),
    ]
    if mine {
      cons.append(b.trailingAnchor.constraint(equalTo: wrap.trailingAnchor))
      cons.append(b.leadingAnchor.constraint(greaterThanOrEqualTo: wrap.leadingAnchor))
    } else {
      cons.append(b.leadingAnchor.constraint(equalTo: wrap.leadingAnchor))
      cons.append(b.trailingAnchor.constraint(lessThanOrEqualTo: wrap.trailingAnchor))
    }
    return cons
  }

  private func bubble(_ m: CLPeekMessage) -> UIView {
    if m.isMedia { return mediaBubble(m) }
    let wrap = UIView()
    let b = UIView()
    b.layer.cornerRadius = 14
    b.backgroundColor = bubbleColor(m)
    let l = UILabel()
    l.numberOfLines = 4
    l.lineBreakMode = .byTruncatingTail
    let textColor: UIColor = m.mine ? (theme.dark ? theme.text : .white) : theme.text
    let a = NSMutableAttributedString()
    if !m.sender.isEmpty {
      a.append(NSAttributedString(string: m.sender + "\n", attributes: [.font: UIFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: theme.sub]))
    }
    a.append(NSAttributedString(string: m.text, attributes: [.font: UIFont.systemFont(ofSize: 15), .foregroundColor: textColor]))
    let metaColor: UIColor = m.mine && !theme.dark ? UIColor(white: 1, alpha: 0.6) : theme.sub
    let meta = metaString(m, color: metaColor)
    if meta.length > 0 {
      a.append(NSAttributedString(string: "  ", attributes: [.font: UIFont.systemFont(ofSize: 11)]))
      a.append(meta)
    }
    l.attributedText = a
    b.addSubview(l)
    wrap.addSubview(b)
    l.translatesAutoresizingMaskIntoConstraints = false
    b.translatesAutoresizingMaskIntoConstraints = false
    var cons: [NSLayoutConstraint] = [
      l.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 12),
      l.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -12),
      l.topAnchor.constraint(equalTo: b.topAnchor, constant: 7),
      l.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -7),
    ]
    cons += place(b, in: wrap, mine: m.mine)
    NSLayoutConstraint.activate(cons)
    return wrap
  }

  /// Foto / vídeo / GIF / figurinha com miniatura real.
  private func mediaBubble(_ m: CLPeekMessage) -> UIView {
    let wrap = UIView()
    let sticker = m.kind == "sticker"
    // Tamanho da miniatura: largura fixa, altura pelo aspecto (limitada).
    let side: CGFloat = sticker ? 96 : 176
    var ih: CGFloat = sticker ? 96 : 150
    if !sticker && m.w > 0 && m.h > 0 {
      ih = min(220, max(96, side * CGFloat(m.h / m.w)))
    }
    let iv = UIImageView()
    iv.contentMode = sticker ? .scaleAspectFit : .scaleAspectFill
    iv.clipsToBounds = true
    iv.layer.cornerRadius = sticker ? 0 : 11
    iv.backgroundColor = sticker ? .clear : (theme.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.06))
    let px = max(side, ih) * UIScreen.main.scale
    if let img = CLImageLoader.shared.cachedImage(m.uri, maxPixel: px) {
      iv.image = img
    } else {
      CLImageLoader.shared.load(m.uri, auth: false, maxPixel: px) { [weak iv] img in
        guard let iv = iv, let img = img else { return }
        UIView.transition(with: iv, duration: 0.15, options: .transitionCrossDissolve, animations: { iv.image = img })
      }
    }
    let b = UIView()
    b.translatesAutoresizingMaskIntoConstraints = false
    iv.translatesAutoresizingMaskIntoConstraints = false
    wrap.addSubview(b)
    b.addSubview(iv)
    var cons: [NSLayoutConstraint] = [
      iv.widthAnchor.constraint(equalToConstant: side),
      iv.heightAnchor.constraint(equalToConstant: ih),
    ]
    let pad: CGFloat = sticker ? 0 : 3
    if !sticker {
      b.backgroundColor = bubbleColor(m)
      b.layer.cornerRadius = 14
    }
    cons += [
      iv.topAnchor.constraint(equalTo: b.topAnchor, constant: pad),
      iv.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: pad),
      iv.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -pad),
    ]
    // Ícone de play (vídeo) / selo "GIF".
    if m.kind == "video" || m.kind == "gif" {
      let badge = UILabel()
      badge.translatesAutoresizingMaskIntoConstraints = false
      badge.textAlignment = .center
      badge.textColor = .white
      badge.backgroundColor = UIColor(white: 0, alpha: 0.45)
      badge.clipsToBounds = true
      if m.kind == "video" {
        let att = NSTextAttachment()
        att.image = UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))?.withTintColor(.white, renderingMode: .alwaysOriginal)
        badge.attributedText = NSAttributedString(attachment: att)
        badge.layer.cornerRadius = 20
        iv.addSubview(badge)
        cons += [badge.centerXAnchor.constraint(equalTo: iv.centerXAnchor), badge.centerYAnchor.constraint(equalTo: iv.centerYAnchor),
                 badge.widthAnchor.constraint(equalToConstant: 40), badge.heightAnchor.constraint(equalToConstant: 40)]
      } else {
        badge.text = "GIF"
        badge.font = UIFont.systemFont(ofSize: 11, weight: .bold)
        badge.layer.cornerRadius = 6
        iv.addSubview(badge)
        cons += [badge.leadingAnchor.constraint(equalTo: iv.leadingAnchor, constant: 6), badge.topAnchor.constraint(equalTo: iv.topAnchor, constant: 6),
                 badge.widthAnchor.constraint(equalToConstant: 32), badge.heightAnchor.constraint(equalToConstant: 18)]
      }
    }
    let onImage = sticker || m.caption.isEmpty
    let metaColor: UIColor = onImage ? .white : (m.mine && !theme.dark ? UIColor(white: 1, alpha: 0.6) : theme.sub)
    let meta = metaString(m, color: metaColor)
    if !m.caption.isEmpty && !sticker {
      // Legenda + hora embaixo da imagem, dentro do balão.
      let l = UILabel()
      l.numberOfLines = 2
      l.lineBreakMode = .byTruncatingTail
      let textColor: UIColor = m.mine ? (theme.dark ? theme.text : .white) : theme.text
      let a = NSMutableAttributedString(string: m.caption, attributes: [.font: UIFont.systemFont(ofSize: 15), .foregroundColor: textColor])
      if meta.length > 0 {
        a.append(NSAttributedString(string: "  ", attributes: [.font: UIFont.systemFont(ofSize: 11)]))
        a.append(meta)
      }
      l.attributedText = a
      l.translatesAutoresizingMaskIntoConstraints = false
      b.addSubview(l)
      cons += [
        l.topAnchor.constraint(equalTo: iv.bottomAnchor, constant: 5),
        l.leadingAnchor.constraint(equalTo: b.leadingAnchor, constant: 9),
        l.trailingAnchor.constraint(equalTo: b.trailingAnchor, constant: -9),
        l.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -6),
      ]
    } else {
      cons.append(iv.bottomAnchor.constraint(equalTo: b.bottomAnchor, constant: -pad))
      if meta.length > 0 {
        // Hora (+ recibo) numa pílula escura sobre a imagem (WhatsApp).
        let pill = UILabel()
        pill.attributedText = meta
        pill.textAlignment = .center
        pill.backgroundColor = UIColor(white: 0, alpha: 0.42)
        pill.layer.cornerRadius = 9
        pill.clipsToBounds = true
        pill.translatesAutoresizingMaskIntoConstraints = false
        b.addSubview(pill)
        let pw = ceil(meta.size().width) + 14
        cons += [
          pill.trailingAnchor.constraint(equalTo: iv.trailingAnchor, constant: -6),
          pill.bottomAnchor.constraint(equalTo: iv.bottomAnchor, constant: -6),
          pill.widthAnchor.constraint(equalToConstant: pw),
          pill.heightAnchor.constraint(equalToConstant: 18),
        ]
      }
    }
    cons += place(b, in: wrap, mine: m.mine, maxW: 1)
    NSLayoutConstraint.activate(cons)
    return wrap
  }

  // MARK: - Layout

  private func contentFit(width sw: CGFloat) -> CGFloat {
    let fit = stack.systemLayoutSizeFitting(CGSize(width: sw, height: UIView.layoutFittingCompressedSize.height),
                                            withHorizontalFittingPriority: .required,
                                            verticalFittingPriority: .fittingSizeLevel)
    return fit.height
  }

  private func rebuild() {
    for v in stack.arrangedSubviews {
      stack.removeArrangedSubview(v)
      v.removeFromSuperview()
    }
    for m in messages { stack.addArrangedSubview(bubble(m)) }
    let width = min(UIScreen.main.bounds.width - 24, 420)
    stack.frame = CGRect(x: 12, y: 0, width: width - 24, height: 10)
    stack.setNeedsLayout()
    stack.layoutIfNeeded()
    // Tamanho FIXO: não depende do conteúdo (nem muda quando o JS completa).
    preferredContentSize = CGSize(width: width, height: fixedHeight())
    view.setNeedsLayout()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let w = view.bounds.width
    let hh = CLPeekController.headerH
    header.frame = CGRect(x: 0, y: 0, width: w, height: hh)
    // Cabeçalho = só o nome centralizado (WhatsApp); avatar pequeno à esquerda.
    avatar.bounds = CGRect(x: 0, y: 0, width: CLAvatarView.box, height: CLAvatarView.box)
    avatar.center = CGPoint(x: 14 + CLAvatarView.box * 0.25, y: hh / 2)
    titleLabel.frame = CGRect(x: 56, y: 0, width: max(0, w - 112), height: hh)
    clip.frame = CGRect(x: 0, y: hh, width: w, height: max(0, view.bounds.height - hh))
    scroll.frame = clip.bounds
    let sw = w - 24
    let fh = contentFit(width: sw)
    // Poucas mensagens: ancoradas EMBAIXO, espaço vazio em cima (WhatsApp).
    let topY = max(12, scroll.bounds.height - fh - 12)
    stack.frame = CGRect(x: 12, y: topY, width: sw, height: fh)
    scroll.contentSize = CGSize(width: w, height: max(fh + 24, scroll.bounds.height))
    // Mostra as mais recentes (fim da conversa), ancoradas embaixo (WhatsApp).
    let maxOff = max(0, scroll.contentSize.height - scroll.bounds.height)
    scroll.contentOffset = CGPoint(x: 0, y: maxOff)
    // Fade no topo só quando há conteúdo cortado acima.
    if maxOff > 0.5 && clip.bounds.height > 0 {
      fade.frame = clip.bounds
      let stop = min(0.3, 36 / clip.bounds.height)
      fade.locations = [0, NSNumber(value: Double(stop)), 1]
      clip.layer.mask = fade
    } else {
      clip.layer.mask = nil
    }
  }
}
