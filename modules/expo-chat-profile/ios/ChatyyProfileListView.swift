import ExpoModulesCore
import UIKit

// [2026-10-15 native-profile] Lista nativa (membros do grupo / grupos em comum).
// Auto-dimensionada; fundo transparente; ações por linha via onRowAction{key, action}.

private final class PFRowButton: UIControl {
  var rowKey = ""
  var action = ""
  let label = UILabel()
  let icon = UIImageView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.isUserInteractionEnabled = false
    label.textAlignment = .center
    addSubview(label)
    icon.isUserInteractionEnabled = false
    icon.contentMode = .center
    addSubview(icon)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds.insetBy(dx: 8, dy: 0)
    icon.frame = bounds
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.08 : 0.25, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
        self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.92, y: 0.92) : .identity
      }
    }
  }
}

private final class PFRowView: UIControl {
  var rowKey = ""
  let avatar = PFAvatarView()
  let avatarTap = PFRowButton()
  let title = UILabel()
  let badge = UILabel()
  let badgeBg = UIView()
  let subtitle = UILabel()
  let link = PFRowButton()
  let chevron = UIImageView()
  let highlight = UIView()
  var buttons: [PFRowButton] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    highlight.isUserInteractionEnabled = false
    highlight.alpha = 0
    addSubview(highlight)
    avatar.isUserInteractionEnabled = false
    avatarTap.addSubview(avatar)
    addSubview(avatarTap)
    for l in [title, subtitle] {
      l.isUserInteractionEnabled = false
      l.lineBreakMode = .byTruncatingTail
      addSubview(l)
    }
    title.font = UIFont.systemFont(ofSize: 15.5, weight: .medium)
    subtitle.font = UIFont.systemFont(ofSize: 12.5)
    badgeBg.isUserInteractionEnabled = false
    badgeBg.layer.cornerRadius = 9
    addSubview(badgeBg)
    badge.font = UIFont.systemFont(ofSize: 10.5, weight: .bold)
    badge.isUserInteractionEnabled = false
    badge.textAlignment = .center
    addSubview(badge)
    link.label.font = UIFont.systemFont(ofSize: 11.5, weight: .semibold)
    link.label.textAlignment = .left
    addSubview(link)
    chevron.image = PFIcon.image("chevron", size: 13, weight: .semibold)
    chevron.contentMode = .center
    chevron.isUserInteractionEnabled = false
    addSubview(chevron)
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.05 : 0.3) {
        self.highlight.alpha = self.isHighlighted ? 1 : 0
      }
    }
  }
}

final class ChatyyProfileListView: ExpoView {
  let onHeightChange = EventDispatcher()
  let onRowAction = EventDispatcher()

  var pendingTheme: [String: Any]? = nil
  var pendingRows: [[String: Any]]? = nil
  var avatarSize: CGFloat = 42 { didSet { if avatarSize != oldValue { setNeedsLayout() } } }
  var emptyText = "" { didSet { if emptyText != oldValue { setNeedsLayout() } } }

  private var theme = PFTheme()
  private var rows: [[String: Any]] = []
  private var rowViews: [PFRowView] = []
  private var separators: [UIView] = []
  private let emptyLabel = UILabel()
  private var lastHeight: CGFloat = -1

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    clipsToBounds = true
    emptyLabel.font = UIFont.systemFont(ofSize: 14)
    emptyLabel.textAlignment = .center
    emptyLabel.isHidden = true
    addSubview(emptyLabel)
  }

  func didUpdateProps() {
    var restyle = false
    if let t = pendingTheme { pendingTheme = nil; theme = PFTheme.from(t); restyle = true }
    if let r = pendingRows {
      pendingRows = nil
      rows = r
      syncRowViews()
      restyle = true
    }
    if restyle {
      for (i, v) in rowViews.enumerated() where i < rows.count { configure(v, rows[i]) }
      for s in separators { s.backgroundColor = theme.hairline }
      emptyLabel.textColor = theme.tertiary
    }
    setNeedsLayout()
  }

  private func syncRowViews() {
    while rowViews.count < rows.count {
      let v = PFRowView()
      v.addTarget(self, action: #selector(rowTapped(_:)), for: .touchUpInside)
      v.avatarTap.addTarget(self, action: #selector(subTapped(_:)), for: .touchUpInside)
      v.link.addTarget(self, action: #selector(subTapped(_:)), for: .touchUpInside)
      addSubview(v)
      rowViews.append(v)
      let s = UIView()
      s.isUserInteractionEnabled = false
      addSubview(s)
      separators.append(s)
    }
    while rowViews.count > rows.count {
      rowViews.removeLast().removeFromSuperview()
      separators.removeLast().removeFromSuperview()
    }
  }

  private func configure(_ v: PFRowView, _ d: [String: Any]) {
    let key = pfStr(d["key"])
    v.rowKey = key
    v.avatarTap.rowKey = key
    v.avatarTap.action = "avatar"
    v.highlight.backgroundColor = theme.hairline
    v.title.text = pfStr(d["title"])
    v.title.textColor = theme.text
    v.subtitle.text = pfStr(d["subtitle"])
    v.subtitle.textColor = theme.tertiary
    let badge = pfStr(d["badge"])
    v.badge.text = badge
    v.badge.textColor = theme.accent
    v.badge.isHidden = badge.isEmpty
    v.badgeBg.isHidden = badge.isEmpty
    v.badgeBg.backgroundColor = theme.accent.withAlphaComponent(0.13)
    if let l = d["link"] as? [String: Any], !pfStr(l["label"]).isEmpty {
      v.link.isHidden = false
      v.link.rowKey = key
      v.link.action = pfStr(l["key"])
      v.link.label.text = pfStr(l["label"])
      v.link.label.textColor = theme.accent
    } else {
      v.link.isHidden = true
    }
    v.chevron.isHidden = !pfBool(d["chevron"])
    v.chevron.tintColor = theme.tertiary
    let color = pfColor(d["avatarColor"], UIColor(white: 0.55, alpha: 1))
    v.avatar.configure(ref: PFImageRef.from(d["avatar"]), initials: pfStr(d["initials"]), color: color, maxPixel: avatarSize * UIScreen.main.scale)
    for b in v.buttons { b.removeFromSuperview() }
    v.buttons = []
    for bd in (d["buttons"] as? [[String: Any]]) ?? [] {
      let b = PFRowButton()
      b.rowKey = key
      b.action = pfStr(bd["key"])
      if pfStr(bd["style"]) == "remove" {
        b.backgroundColor = theme.destructive.withAlphaComponent(0.12)
        b.icon.image = PFIcon.image("x", size: 12, weight: .bold)
        b.icon.tintColor = theme.destructive
        b.layer.cornerRadius = 15
        b.accessibilityLabel = pfStr(bd["label"])
      } else {
        b.backgroundColor = theme.hairline
        b.label.text = pfStr(bd["label"])
        b.label.font = UIFont.systemFont(ofSize: 11.5, weight: .semibold)
        b.label.textColor = theme.text
        b.layer.cornerRadius = 9
        b.layer.cornerCurve = .continuous
        b.accessibilityLabel = pfStr(bd["label"])
      }
      b.isAccessibilityElement = true
      b.accessibilityTraits = .button
      b.addTarget(self, action: #selector(subTapped(_:)), for: .touchUpInside)
      v.addSubview(b)
      v.buttons.append(b)
    }
    v.accessibilityLabel = [v.title.text, v.subtitle.text].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
  }

  private func rowHeight(_ d: [String: Any]) -> CGFloat {
    let hasSub = !pfStr(d["subtitle"]).isEmpty
    var h: CGFloat = hasSub ? 60 : 52
    if let l = d["link"] as? [String: Any], !pfStr(l["label"]).isEmpty { h += 18 }
    return max(h, avatarSize + 14)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    if W <= 0 { return }
    let A = avatarSize
    let tx = 14 + A + 12
    var y: CGFloat = 0
    let hl = 1 / UIScreen.main.scale
    for (i, v) in rowViews.enumerated() where i < rows.count {
      let d = rows[i]
      let h = rowHeight(d)
      v.frame = CGRect(x: 0, y: y, width: W, height: h)
      v.highlight.frame = v.bounds
      v.avatarTap.frame = CGRect(x: 14, y: (h - A) / 2, width: A, height: A)
      v.avatar.frame = v.avatarTap.bounds
      // direita: botões (da direita p/ esquerda) e chevron
      var right = W - 14
      if !v.chevron.isHidden {
        v.chevron.frame = CGRect(x: right - 14, y: 0, width: 14, height: h)
        right -= 22
      }
      for b in v.buttons.reversed() {
        let isRemove = b.label.text?.isEmpty ?? true
        let bw: CGFloat = isRemove ? 30 : min(140, ceil(b.label.sizeThatFits(CGSize(width: 300, height: 28)).width) + 20)
        let bh: CGFloat = isRemove ? 30 : 28
        b.frame = CGRect(x: right - bw, y: (h - bh) / 2, width: bw, height: bh)
        right -= bw + 6
      }
      let textW = max(40, right - tx - 4)
      let hasSub = !(v.subtitle.text ?? "").isEmpty
      let hasLink = !v.link.isHidden
      let block: CGFloat = 21 + (hasSub ? 17 : 0) + (hasLink ? 18 : 0)
      var ty = (h - block) / 2
      let badgeText = v.badge.text ?? ""
      let badgeW: CGFloat = badgeText.isEmpty ? 0 : ceil(v.badge.sizeThatFits(CGSize(width: 200, height: 18)).width) + 14
      let titleFit = ceil(v.title.sizeThatFits(CGSize(width: 2000, height: 21)).width)
      let titleW = min(titleFit, max(20, textW - (badgeW > 0 ? badgeW + 6 : 0)))
      v.title.frame = CGRect(x: tx, y: ty, width: titleW, height: 21)
      if badgeW > 0 {
        let bf = CGRect(x: tx + titleW + 6, y: ty + 1.5, width: badgeW, height: 18)
        v.badgeBg.frame = bf
        v.badge.frame = bf
      }
      ty += 21
      if hasSub {
        v.subtitle.frame = CGRect(x: tx, y: ty, width: textW, height: 17)
        ty += 17
      }
      if hasLink {
        let lw = min(textW, ceil(v.link.label.sizeThatFits(CGSize(width: 400, height: 18)).width) + 2)
        v.link.frame = CGRect(x: tx - 8, y: ty, width: lw + 16, height: 18)
        v.link.label.frame = CGRect(x: 8, y: 0, width: lw, height: 18)
      }
      let sep = separators[i]
      sep.isHidden = i == rows.count - 1
      sep.frame = CGRect(x: tx, y: y + h - hl, width: W - tx, height: hl)
      y += h
    }
    if rows.isEmpty && !emptyText.isEmpty {
      emptyLabel.isHidden = false
      emptyLabel.text = emptyText
      emptyLabel.frame = CGRect(x: 16, y: 0, width: W - 32, height: 64)
      y = 64
    } else {
      emptyLabel.isHidden = true
    }
    reportHeight(y)
  }

  private func reportHeight(_ h: CGFloat) {
    let r = ceil(h)
    guard abs(r - lastHeight) >= 0.5 else { return }
    lastHeight = r
    setStyleSize(nil, height: NSNumber(value: Float(r)))
    onHeightChange(["height": Double(r)])
  }

  @objc private func rowTapped(_ v: PFRowView) {
    onRowAction(["key": v.rowKey, "action": "row"])
  }

  @objc private func subTapped(_ b: PFRowButton) {
    UISelectionFeedbackGenerator().selectionChanged()
    onRowAction(["key": b.rowKey, "action": b.action])
  }
}
