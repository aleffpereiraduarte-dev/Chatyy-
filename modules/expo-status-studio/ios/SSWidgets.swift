import UIKit

// [2026-10-15 native-status-studio] Blocos interativos no estúdio com o MESMO
// visual (tamanhos em pontos do viewer) dos blocos do visualizador nativo
// (expo-media-viewer/ios/StoryOverlays.swift). No palco eles aparecem
// escalados por stageW/screenW — proporção idêntica ao que o viewer pinta.

class SSWidgetView: UIView {
  func apply(_ l: SSLayer, _ opts: SSOptions) {}
  var blockSize: CGSize { return .zero }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  static func make(_ l: SSLayer, _ opts: SSOptions) -> SSWidgetView? {
    let v: SSWidgetView
    switch l.kind {
    case .poll: v = SSPollWidget()
    case .question: v = SSQuestionWidget()
    case .countdown: v = SSCountdownWidget()
    case .mention: v = SSPillWidget(symbol: nil)
    case .link: v = SSPillWidget(symbol: "link")
    case .music: v = SSMusicWidget()
    default: return nil
    }
    v.apply(l, opts)
    return v
  }
}

private func wFont(_ s: CGFloat, _ w: UIFont.Weight) -> UIFont { return .systemFont(ofSize: s, weight: w) }

// MARK: Enquete

final class SSPollWidget: SSWidgetView {
  private let title = UILabel()
  private var rows: [UIView] = []
  private var labels: [UILabel] = []
  static let width: CGFloat = 250

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(white: 0, alpha: 0.72)
    layer.cornerRadius = 16
    layer.borderWidth = 1
    layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    title.textColor = .white
    title.font = wFont(15, .bold)
    title.textAlignment = .center
    title.numberOfLines = 3
    addSubview(title)
    for _ in 0..<2 {
      let r = UIView()
      r.backgroundColor = UIColor(white: 1, alpha: 0.16)
      r.layer.cornerRadius = 19
      let l = UILabel()
      l.font = wFont(14, .semibold)
      l.textColor = .white
      l.lineBreakMode = .byTruncatingTail
      r.addSubview(l)
      addSubview(r)
      rows.append(r)
      labels.append(l)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func apply(_ l: SSLayer, _ opts: SSOptions) {
    title.text = l.text
    labels[0].text = l.optionA
    labels[1].text = l.optionB
    setNeedsLayout()
  }

  override var blockSize: CGSize {
    let w = SSPollWidget.width
    let th = (title.text ?? "").isEmpty ? 0 : ceil(title.sizeThatFits(CGSize(width: w - 28, height: 200)).height) + 10
    return CGSize(width: w, height: 14 + th + 2 * 46 - 8 + 14)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    var y: CGFloat = 14
    if !(title.text ?? "").isEmpty {
      let th = ceil(title.sizeThatFits(CGSize(width: w - 28, height: 200)).height)
      title.frame = CGRect(x: 14, y: y, width: w - 28, height: th)
      y += th + 10
    } else {
      title.frame = .zero
    }
    for (i, r) in rows.enumerated() {
      r.frame = CGRect(x: 12, y: y, width: w - 24, height: 38)
      labels[i].frame = CGRect(x: 14, y: 0, width: r.bounds.width - 28, height: 38)
      y += 46
    }
  }
}

// MARK: Pergunta

final class SSQuestionWidget: SSWidgetView {
  private let prompt = UILabel()
  private let fieldBox = UIView()
  private let field = UILabel()
  static let width: CGFloat = 250

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .white
    layer.cornerRadius = 16
    prompt.textColor = .black
    prompt.font = wFont(15, .bold)
    prompt.textAlignment = .center
    prompt.numberOfLines = 3
    addSubview(prompt)
    fieldBox.backgroundColor = UIColor(white: 0, alpha: 0.07)
    fieldBox.layer.cornerRadius = 18
    addSubview(fieldBox)
    field.textColor = UIColor(white: 0, alpha: 0.45)
    field.font = wFont(13, .medium)
    field.textAlignment = .center
    addSubview(field)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func apply(_ l: SSLayer, _ opts: SSOptions) {
    prompt.text = l.text
    field.text = opts.t("tapToReply", "Toque para responder")
    setNeedsLayout()
  }

  override var blockSize: CGSize {
    let w = SSQuestionWidget.width
    let ph = ceil(prompt.sizeThatFits(CGSize(width: w - 28, height: 200)).height)
    return CGSize(width: w, height: 14 + ph + 10 + 36 + 14)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    let ph = ceil(prompt.sizeThatFits(CGSize(width: w - 28, height: 200)).height)
    prompt.frame = CGRect(x: 14, y: 14, width: w - 28, height: ph)
    fieldBox.frame = CGRect(x: 14, y: prompt.frame.maxY + 10, width: w - 28, height: 36)
    field.frame = fieldBox.frame.insetBy(dx: 10, dy: 0)
  }
}

// MARK: Contagem regressiva

final class SSCountdownWidget: SSWidgetView {
  private let title = UILabel()
  private let time = UILabel()
  private let date = UILabel()
  private var target: Date?
  private var ended = "Encerrado"
  static let width: CGFloat = 220

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(white: 0, alpha: 0.72)
    layer.cornerRadius = 16
    layer.borderWidth = 1
    layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    title.textColor = UIColor(white: 1, alpha: 0.85)
    title.font = wFont(12, .semibold)
    title.textAlignment = .center
    addSubview(title)
    time.textColor = .white
    time.font = UIFont.monospacedDigitSystemFont(ofSize: 26, weight: .bold)
    time.textAlignment = .center
    time.adjustsFontSizeToFitWidth = true
    time.minimumScaleFactor = 0.6
    addSubview(time)
    date.textColor = UIColor(white: 1, alpha: 0.65)
    date.font = wFont(11, .medium)
    date.textAlignment = .center
    addSubview(date)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func apply(_ l: SSLayer, _ opts: SSOptions) {
    title.text = l.text
    target = l.target
    ended = opts.t("ended", "Encerrado")
    if let t = l.target {
      let f = DateFormatter()
      f.dateStyle = .medium
      f.timeStyle = .short
      date.text = f.string(from: t)
    } else {
      date.text = ""
    }
    tick()
  }

  override var blockSize: CGSize { return CGSize(width: SSCountdownWidget.width, height: 96) }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    title.frame = CGRect(x: 12, y: 12, width: w - 24, height: 16)
    time.frame = CGRect(x: 12, y: 30, width: w - 24, height: 34)
    date.frame = CGRect(x: 12, y: 68, width: w - 24, height: 16)
  }

  func tick() {
    guard let t = target else { time.text = "00:00:00"; return }
    let left = Int(floor(t.timeIntervalSinceNow))
    if left <= 0 { time.text = ended; return }
    let d = left / 86400
    let h = (left % 86400) / 3600
    let m = (left % 3600) / 60
    let s = left % 60
    let hms = String(format: "%02ld:%02ld:%02ld", h, m, s)
    time.text = d > 0 ? "\(d)d \(hms)" : hms
  }
}

// MARK: Menção / link (pílula branca)

final class SSPillWidget: SSWidgetView {
  private let label = UILabel()
  private let icon = UIImageView()
  private let hasIcon: Bool

  init(symbol: String?) {
    hasIcon = symbol != nil
    super.init(frame: .zero)
    backgroundColor = .white
    layer.cornerRadius = 19
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 6
    layer.shadowOffset = CGSize(width: 0, height: 2)
    label.textColor = .black
    label.font = wFont(16, .bold)
    label.lineBreakMode = .byTruncatingTail
    addSubview(label)
    if let s = symbol {
      icon.image = ssSymbol(s, 14, .bold)
      icon.tintColor = .black
      icon.contentMode = .center
      addSubview(icon)
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func apply(_ l: SSLayer, _ opts: SSOptions) {
    if l.kind == .mention {
      let u = l.text.hasPrefix("@") ? l.text : "@\(l.text)"
      label.text = u
    } else {
      label.text = l.text.isEmpty ? l.url : l.text
    }
    setNeedsLayout()
  }

  override var blockSize: CGSize {
    let s = label.sizeThatFits(CGSize(width: 300, height: 40))
    let iw: CGFloat = hasIcon ? 22 : 0
    return CGSize(width: min(320, ceil(s.width) + 32 + iw), height: 38)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let iw: CGFloat = hasIcon ? 22 : 0
    icon.frame = CGRect(x: 14, y: 0, width: 18, height: bounds.height)
    label.frame = CGRect(x: 16 + iw, y: 0, width: bounds.width - 32 - iw, height: bounds.height)
  }
}

// MARK: Música (cartão; o viewer mostra a pílula de música)

final class SSMusicWidget: SSWidgetView {
  private let cover = UIImageView()
  private let note = UIImageView()
  private let title = UILabel()
  private let artist = UILabel()
  private var coverUrl = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(white: 0, alpha: 0.72)
    layer.cornerRadius = 14
    layer.borderWidth = 1
    layer.borderColor = UIColor(white: 1, alpha: 0.16).cgColor
    cover.backgroundColor = UIColor(white: 1, alpha: 0.12)
    cover.layer.cornerRadius = 8
    cover.clipsToBounds = true
    cover.contentMode = .scaleAspectFill
    addSubview(cover)
    note.image = ssSymbol("music.note", 18, .bold)
    note.tintColor = .white
    note.contentMode = .center
    addSubview(note)
    title.textColor = .white
    title.font = wFont(15, .bold)
    addSubview(title)
    artist.textColor = UIColor(white: 1, alpha: 0.7)
    artist.font = wFont(13, .medium)
    addSubview(artist)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) not supported") }

  override func apply(_ l: SSLayer, _ opts: SSOptions) {
    title.text = l.text
    artist.text = l.artist
    if l.cover != coverUrl {
      coverUrl = l.cover
      cover.image = nil
      note.isHidden = false
      if let u = URL(string: l.cover), u.scheme?.hasPrefix("http") == true {
        let want = l.cover
        URLSession.shared.dataTask(with: u) { [weak self] d, _, _ in
          guard let d = d, let img = UIImage(data: d) else { return }
          DispatchQueue.main.async {
            guard let self = self, self.coverUrl == want else { return }
            self.cover.image = img
            self.note.isHidden = true
          }
        }.resume()
      }
    }
    setNeedsLayout()
  }

  override var blockSize: CGSize { return CGSize(width: 240, height: 64) }

  override func layoutSubviews() {
    super.layoutSubviews()
    cover.frame = CGRect(x: 10, y: 10, width: 44, height: 44)
    note.frame = cover.frame
    let x: CGFloat = 64
    title.frame = CGRect(x: x, y: 13, width: bounds.width - x - 12, height: 20)
    artist.frame = CGRect(x: x, y: 33, width: bounds.width - x - 12, height: 18)
  }
}
