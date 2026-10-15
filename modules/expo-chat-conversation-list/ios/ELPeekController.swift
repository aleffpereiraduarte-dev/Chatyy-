import UIKit

// [2026-10-15 native-inbox] Prévia (peek) do toque longo no e-mail: avatar,
// remetente + endereço, data, assunto e o corpo em texto. Abre na hora com a
// prévia da linha; o JS responde ao onPeekRequest com o corpo do cache local
// (prop `peek` {id, body}) e o texto se completa sem fechar.
final class ELPeekController: UIViewController {
  let emailId: String
  private let row: ELRow
  private let palette: ELPalette
  private let avatar = CLAvatarView()
  private let fromLabel = UILabel()
  private let addrLabel = UILabel()
  private let dateLabel = UILabel()
  private let subjectLabel = UILabel()
  private let hair = UIView()
  private let bodyLabel = UILabel()
  private var body: String

  init(row: ELRow, palette: ELPalette) {
    self.emailId = row.id
    self.row = row
    self.palette = palette
    self.body = row.preview
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = palette.bg
    avatar.boxSize = 40
    avatar.configure(row.avatar, theme: CLTheme(dark: palette.dark), rowBackground: palette.bg)
    view.addSubview(avatar)
    fromLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    fromLabel.textColor = palette.text
    fromLabel.text = row.from
    addrLabel.font = UIFont.systemFont(ofSize: 13)
    addrLabel.textColor = palette.faint
    addrLabel.text = row.fromEmail
    dateLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    dateLabel.textColor = palette.faint
    dateLabel.textAlignment = .right
    dateLabel.text = row.dateFull.isEmpty ? row.time : row.dateFull
    subjectLabel.font = UIFont.systemFont(ofSize: 18, weight: .semibold)
    subjectLabel.textColor = palette.text
    subjectLabel.numberOfLines = 3
    subjectLabel.text = row.subject
    hair.backgroundColor = palette.hair
    bodyLabel.font = UIFont.systemFont(ofSize: 15)
    bodyLabel.textColor = palette.sub
    bodyLabel.numberOfLines = 0
    bodyLabel.lineBreakMode = .byTruncatingTail
    for v in [fromLabel, addrLabel, dateLabel, subjectLabel, hair, bodyLabel] as [UIView] {
      view.addSubview(v)
    }
    refreshBody()
  }

  /// Corpo vindo do JS (`peek`); ignora prévias de outro e-mail.
  func update(_ dict: [String: Any]) {
    guard CLVal.str(dict["id"]) == emailId else { return }
    let b = CLVal.str(dict["body"])
    if b.isEmpty || b == body { return }
    body = b
    if isViewLoaded { refreshBody() }
  }

  private func refreshBody() {
    let style = NSMutableParagraphStyle()
    style.lineSpacing = 3
    bodyLabel.attributedText = NSAttributedString(string: String(body.prefix(2400)), attributes: [
      .font: UIFont.systemFont(ofSize: 15),
      .foregroundColor: palette.sub,
      .paragraphStyle: style,
    ])
    updateSize()
    view.setNeedsLayout()
  }

  private func updateSize() {
    let screen = view.window?.windowScene?.screen.bounds ?? UIScreen.main.bounds
    let w = min(screen.width - 24, 520)
    let h = min(screen.height * 0.62, max(240, measuredHeight(width: w)))
    preferredContentSize = CGSize(width: w, height: ceil(h))
  }

  private func measuredHeight(width w: CGFloat) -> CGFloat {
    let inner = w - 40
    let subj = subjectLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
    let bodyH = bodyLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
    return 20 + 40 + 14 + subj + 12 + 1 + 12 + bodyH + 20
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let w = view.bounds.width
    let x: CGFloat = 20
    let inner = w - x * 2
    avatar.frame = CGRect(x: x, y: 20, width: 40, height: 40)
    let dw = min(140, ceil(dateLabel.intrinsicContentSize.width))
    dateLabel.frame = CGRect(x: w - x - dw, y: 22, width: dw, height: 18)
    let tx = x + 40 + 12
    fromLabel.frame = CGRect(x: tx, y: 20, width: max(0, w - x - dw - 8 - tx), height: 21)
    addrLabel.frame = CGRect(x: tx, y: 42, width: max(0, w - x - tx), height: 18)
    var y: CGFloat = 20 + 40 + 14
    let subjH = subjectLabel.sizeThatFits(CGSize(width: inner, height: .greatestFiniteMagnitude)).height
    subjectLabel.frame = CGRect(x: x, y: y, width: inner, height: ceil(subjH))
    y += ceil(subjH) + 12
    hair.frame = CGRect(x: x, y: y, width: inner, height: 1.0 / max(1, view.traitCollection.displayScale))
    y += 13
    bodyLabel.frame = CGRect(x: x, y: y, width: inner, height: max(0, view.bounds.height - y - 16))
  }
}
