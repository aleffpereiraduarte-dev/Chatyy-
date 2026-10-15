import UIKit

// [2026-10-14 native-home] Prévia (peek) do toque longo: cabeçalho com avatar
// + nome e as últimas mensagens em balões. Abre na hora com a última prévia
// da linha; o JS responde ao onPeekRequest com as mensagens do cache local
// (prop `peek`) e a prévia se completa sem fechar.
struct CLPeekMessage {
  let mine: Bool
  let text: String
  let time: String
  let sender: String
  var receipt: Int = 0
}

final class CLPeekController: UIViewController {
  let convId: String
  private var row: CLRow
  private let theme: CLTheme
  private let header = UIView()
  private let avatar = CLAvatarView()
  private let titleLabel = UILabel()
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private var messages: [CLPeekMessage] = []

  init(row: CLRow, theme: CLTheme) {
    self.convId = row.id
    self.row = row
    self.theme = theme
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    // Área das mensagens no tom do fundo da conversa; cabeçalho em vidro.
    view.backgroundColor = theme.dark ? UIColor(clHex: 0x0B0B0B) : UIColor(clHex: 0xEFEFEF)
    header.backgroundColor = theme.dark ? UIColor(clHex: 0x1C1C1E) : UIColor(clHex: 0xF7F7F7)
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
    view.addSubview(scroll)
    stack.axis = .vertical
    stack.spacing = 6
    stack.alignment = .fill
    scroll.addSubview(stack)
    if messages.isEmpty { seedFromRow() }
    rebuild()
  }

  private func seedFromRow() {
    let txt = row.locked ? row.text : (row.text.isEmpty ? row.empty : row.text)
    if txt.isEmpty { return }
    let mine = row.receipt > 0
    messages = [CLPeekMessage(mine: mine, text: txt, time: row.time, sender: mine ? "" : (row.isGroupish ? row.sender : ""), receipt: row.receipt)]
  }

  func update(_ dict: [String: Any]) {
    guard CLVal.str(dict["id"]) == convId else { return }
    let items = (dict["items"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
    if items.isEmpty { return }
    messages = items.suffix(12).map {
      CLPeekMessage(mine: CLVal.bool($0["m"]), text: CLVal.str($0["t"]), time: CLVal.str($0["h"]), sender: CLVal.str($0["s"]), receipt: CLVal.int($0["r"]))
    }
    if isViewLoaded { rebuild() }
  }

  private func bubble(_ m: CLPeekMessage) -> UIView {
    let wrap = UIView()
    let b = UIView()
    b.layer.cornerRadius = 14
    b.backgroundColor = m.mine ? (theme.dark ? UIColor(clHex: 0x2C2C2E) : UIColor(clHex: 0x0B0B0B)) : (theme.dark ? UIColor(clHex: 0x1C1C1E) : .white)
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
    if !m.time.isEmpty {
      a.append(NSAttributedString(string: "  " + m.time, attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular), .foregroundColor: metaColor]))
    }
    if m.mine, let img = CLReceiptView.image(state: m.receipt, gray: metaColor, read: theme.receiptRead, height: 11) {
      let att = NSTextAttachment()
      att.image = img
      att.bounds = CGRect(x: 0, y: -1, width: img.size.width, height: img.size.height)
      a.append(NSAttributedString(string: " ", attributes: [.font: UIFont.systemFont(ofSize: 11)]))
      a.append(NSAttributedString(attachment: att))
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
      b.topAnchor.constraint(equalTo: wrap.topAnchor),
      b.bottomAnchor.constraint(equalTo: wrap.bottomAnchor),
      b.widthAnchor.constraint(lessThanOrEqualTo: wrap.widthAnchor, multiplier: 0.8),
    ]
    if m.mine {
      cons.append(b.trailingAnchor.constraint(equalTo: wrap.trailingAnchor))
      cons.append(b.leadingAnchor.constraint(greaterThanOrEqualTo: wrap.leadingAnchor))
    } else {
      cons.append(b.leadingAnchor.constraint(equalTo: wrap.leadingAnchor))
      cons.append(b.trailingAnchor.constraint(lessThanOrEqualTo: wrap.trailingAnchor))
    }
    NSLayoutConstraint.activate(cons)
    return wrap
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
    let fit = stack.systemLayoutSizeFitting(CGSize(width: width - 24, height: UIView.layoutFittingCompressedSize.height),
                                            withHorizontalFittingPriority: .required,
                                            verticalFittingPriority: .fittingSizeLevel)
    let contentH = max(40, fit.height)
    let headerH: CGFloat = 60
    let maxH = min(UIScreen.main.bounds.height * 0.6, 560)
    let h = min(maxH, headerH + 12 + contentH + 12)
    preferredContentSize = CGSize(width: width, height: h)
    view.setNeedsLayout()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let w = view.bounds.width
    header.frame = CGRect(x: 0, y: 0, width: w, height: 60)
    // Cabeçalho = só o nome centralizado (WhatsApp); avatar pequeno à esquerda.
    avatar.bounds = CGRect(x: 0, y: 0, width: CLAvatarView.box, height: CLAvatarView.box)
    avatar.center = CGPoint(x: 14 + CLAvatarView.box * 0.25, y: 30)
    titleLabel.frame = CGRect(x: 56, y: 0, width: max(0, w - 112), height: 60)
    scroll.frame = CGRect(x: 0, y: 60, width: w, height: max(0, view.bounds.height - 60))
    let sw = w - 24
    let fit = stack.systemLayoutSizeFitting(CGSize(width: sw, height: UIView.layoutFittingCompressedSize.height),
                                            withHorizontalFittingPriority: .required,
                                            verticalFittingPriority: .fittingSizeLevel)
    stack.frame = CGRect(x: 12, y: 12, width: sw, height: fit.height)
    scroll.contentSize = CGSize(width: w, height: fit.height + 24)
    // Mostra as mais recentes (fim da conversa), como o WhatsApp.
    let maxOff = max(0, scroll.contentSize.height - scroll.bounds.height)
    scroll.contentOffset = CGPoint(x: 0, y: maxOff)
  }
}
