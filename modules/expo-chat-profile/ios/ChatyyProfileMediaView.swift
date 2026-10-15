import ExpoModulesCore
import UIKit

// [2026-10-15 native-profile] Abas Mídia | Links | Arquivos com grade nativa de
// miniaturas. Auto-dimensionada: setStyleSize + onHeightChange. Fundo
// transparente (o JS envolve no cartão da folha).

private final class PFTapControl: UIControl {
  var key = ""
  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: isHighlighted ? 0.08 : 0.25) {
        self.alpha = self.isHighlighted ? 0.6 : 1
      }
    }
  }
}

private struct PFMediaItem {
  let key: String
  let ref: PFImageRef?
  let video: Bool
  let duration: String
}

private struct PFRowItem {
  let key: String
  let title: String
  let subtitle: String
  let ext: String
}

final class ChatyyProfileMediaView: ExpoView {
  let onHeightChange = EventDispatcher()
  let onItem = EventDispatcher()
  let onSeeAll = EventDispatcher()
  let onTabChange = EventDispatcher()

  var pendingTheme: [String: Any]? = nil
  var pendingTabs: [[String: Any]]? = nil
  var selectedProp = "" { didSet { if selectedProp != oldValue { selectedDirty = true } } }
  var pendingMedia: [[String: Any]]? = nil
  var pendingLinks: [[String: Any]]? = nil
  var pendingFiles: [[String: Any]]? = nil
  var labels: [String: String] = [:] { didSet { contentDirty = true } }
  var maxItems = 9 { didSet { if maxItems != oldValue { contentDirty = true } } }

  private var theme = PFTheme()
  private var tabs: [(key: String, label: String)] = []
  private var selected = ""
  private var media: [PFMediaItem] = []
  private var links: [PFRowItem] = []
  private var files: [PFRowItem] = []
  private var selectedDirty = false
  private var contentDirty = true

  private let tabBar = UIView()
  private var tabButtons: [UIButton] = []
  private let underline = UIView()
  private let tabHairline = UIView()
  private var content = UIView()
  private let footer = PFTapControl()
  private let footerLabel = UILabel()
  private let footerChevron = UIImageView()
  private var lastHeight: CGFloat = -1
  private var lastWidth: CGFloat = 0

  private let tabBarH: CGFloat = 44
  private let footerH: CGFloat = 44
  private let rowH: CGFloat = 56

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear
    addSubview(tabBar)
    underline.layer.cornerRadius = 1
    tabBar.addSubview(underline)
    tabBar.addSubview(tabHairline)
    addSubview(content)
    footerLabel.font = UIFont.systemFont(ofSize: 15, weight: .medium)
    footerLabel.isUserInteractionEnabled = false
    footer.addSubview(footerLabel)
    footerChevron.image = PFIcon.image("chevron", size: 13, weight: .semibold)
    footerChevron.contentMode = .center
    footerChevron.isUserInteractionEnabled = false
    footer.addSubview(footerChevron)
    footer.addTarget(self, action: #selector(footerTapped), for: .touchUpInside)
    addSubview(footer)
    applyTheme()
  }

  func didUpdateProps() {
    if let t = pendingTheme { pendingTheme = nil; theme = PFTheme.from(t); applyTheme(); contentDirty = true }
    if let t = pendingTabs {
      pendingTabs = nil
      tabs = t.map { (key: pfStr($0["key"]), label: pfStr($0["label"])) }.filter { !$0.key.isEmpty }
      rebuildTabs()
      contentDirty = true
    }
    if let m = pendingMedia {
      pendingMedia = nil
      media = m.map { PFMediaItem(key: pfStr($0["key"]), ref: PFImageRef.from($0), video: pfBool($0["video"]), duration: pfStr($0["duration"])) }
      contentDirty = true
    }
    if let l = pendingLinks {
      pendingLinks = nil
      links = l.map { PFRowItem(key: pfStr($0["key"]), title: pfStr($0["title"]), subtitle: pfStr($0["subtitle"]), ext: "") }
      contentDirty = true
    }
    if let f = pendingFiles {
      pendingFiles = nil
      files = f.map { PFRowItem(key: pfStr($0["key"]), title: pfStr($0["title"]), subtitle: pfStr($0["subtitle"]), ext: pfStr($0["ext"])) }
      contentDirty = true
    }
    if selectedDirty || selected.isEmpty {
      selectedDirty = false
      let s = tabs.contains(where: { $0.key == selectedProp }) ? selectedProp : (tabs.first?.key ?? "")
      if s != selected { selected = s; contentDirty = true }
    }
    if contentDirty {
      contentDirty = false
      rebuildContent(animated: false)
    }
  }

  private func applyTheme() {
    underline.backgroundColor = theme.text
    tabHairline.backgroundColor = theme.hairline
    footerLabel.textColor = theme.text
    footerChevron.tintColor = theme.tertiary
    tintTabs()
  }

  private func rebuildTabs() {
    for b in tabButtons { b.removeFromSuperview() }
    tabButtons = []
    for (i, t) in tabs.enumerated() {
      let b = UIButton(type: .system)
      b.setTitle(t.label, for: .normal)
      b.tag = i
      b.addTarget(self, action: #selector(tabTapped(_:)), for: .touchUpInside)
      tabBar.addSubview(b)
      tabButtons.append(b)
    }
    tintTabs()
    setNeedsLayout()
  }

  private func tintTabs() {
    for b in tabButtons {
      let sel = b.tag < tabs.count && tabs[b.tag].key == selected
      b.setTitleColor(sel ? theme.text : theme.secondary, for: .normal)
      b.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: sel ? .semibold : .regular)
    }
  }

  // MARK: Conteúdo

  private func currentCount() -> Int {
    switch selected {
    case "links": return links.count
    case "files": return files.count
    default: return media.count
    }
  }

  private func contentHeight(width W: CGFloat) -> CGFloat {
    let n = currentCount()
    if n == 0 { return 64 }
    switch selected {
    case "links", "files":
      return CGFloat(min(n, 5)) * rowH
    default:
      let cnt = min(n, max(3, maxItems))
      let rows = CGFloat((cnt + 2) / 3)
      let side = floor((W - 4) / 3)
      return rows * side + max(0, rows - 1) * 2
    }
  }

  private func rebuildContent(animated: Bool) {
    let W = bounds.width
    let old = content
    let fresh = UIView()
    fresh.clipsToBounds = true
    if W > 0 { fillContent(fresh, width: W) }
    insertSubview(fresh, belowSubview: footer)
    content = fresh
    footerLabel.text = labels["seeAll"] ?? "Ver tudo"
    footer.isHidden = currentCount() == 0
    tintTabs()
    if animated {
      fresh.alpha = 0
      UIView.animate(withDuration: 0.22, animations: {
        fresh.alpha = 1
        old.alpha = 0
      }, completion: { _ in old.removeFromSuperview() })
    } else {
      old.removeFromSuperview()
    }
    setNeedsLayout()
    layoutIfNeeded()
  }

  private func fillContent(_ host: UIView, width W: CGFloat) {
    let n = currentCount()
    if n == 0 {
      let l = UILabel()
      l.text = labels["empty"] ?? ""
      l.textColor = theme.tertiary
      l.font = UIFont.systemFont(ofSize: 14)
      l.textAlignment = .center
      l.frame = CGRect(x: 16, y: 0, width: W - 32, height: 64)
      host.addSubview(l)
      return
    }
    switch selected {
    case "links", "files":
      let list = selected == "links" ? links : files
      for (i, it) in list.prefix(5).enumerated() {
        let row = PFTapControl(frame: CGRect(x: 0, y: CGFloat(i) * rowH, width: W, height: rowH))
        row.key = it.key
        row.addTarget(self, action: #selector(itemTapped(_:)), for: .touchUpInside)
        let badge = UIView(frame: CGRect(x: 14, y: 8, width: 40, height: 40))
        badge.layer.cornerRadius = 8
        badge.layer.cornerCurve = .continuous
        badge.backgroundColor = theme.hairline
        badge.isUserInteractionEnabled = false
        if selected == "links" || it.ext.isEmpty {
          let iv = UIImageView(image: PFIcon.image(selected == "links" ? "link" : "file", size: 16, weight: .medium))
          iv.tintColor = theme.text
          iv.contentMode = .center
          iv.frame = badge.bounds
          badge.addSubview(iv)
        } else {
          let l = UILabel(frame: badge.bounds.insetBy(dx: 2, dy: 0))
          l.text = String(it.ext.uppercased().prefix(4))
          l.font = UIFont.systemFont(ofSize: 11, weight: .bold)
          l.textColor = theme.text
          l.textAlignment = .center
          l.adjustsFontSizeToFitWidth = true
          badge.addSubview(l)
        }
        row.addSubview(badge)
        let tx: CGFloat = 14 + 40 + 12
        let t = UILabel(frame: CGRect(x: tx, y: it.subtitle.isEmpty ? 18 : 9, width: W - tx - 14, height: 20))
        t.text = it.title
        t.font = UIFont.systemFont(ofSize: 15)
        t.textColor = theme.text
        t.lineBreakMode = .byTruncatingMiddle
        t.isUserInteractionEnabled = false
        row.addSubview(t)
        if !it.subtitle.isEmpty {
          let s = UILabel(frame: CGRect(x: tx, y: 30, width: W - tx - 14, height: 17))
          s.text = it.subtitle
          s.font = UIFont.systemFont(ofSize: 13)
          s.textColor = theme.tertiary
          s.lineBreakMode = .byTruncatingTail
          s.isUserInteractionEnabled = false
          row.addSubview(s)
        }
        row.isAccessibilityElement = true
        row.accessibilityLabel = it.title
        row.accessibilityTraits = .button
        host.addSubview(row)
        if i < min(list.count, 5) - 1 {
          let hl = UIView(frame: CGRect(x: tx, y: CGFloat(i + 1) * rowH - (1 / UIScreen.main.scale), width: W - tx, height: 1 / UIScreen.main.scale))
          hl.backgroundColor = theme.hairline
          host.addSubview(hl)
        }
      }
    default:
      let side = floor((W - 4) / 3)
      let cnt = min(media.count, max(3, maxItems))
      for i in 0..<cnt {
        let it = media[i]
        let col = i % 3, row = i / 3
        let cell = PFTapControl(frame: CGRect(x: CGFloat(col) * (side + 2), y: CGFloat(row) * (side + 2), width: side, height: side))
        cell.key = it.key
        cell.clipsToBounds = true
        cell.backgroundColor = theme.hairline
        cell.addTarget(self, action: #selector(itemTapped(_:)), for: .touchUpInside)
        let iv = UIImageView(frame: cell.bounds)
        iv.contentMode = .scaleAspectFill
        iv.clipsToBounds = true
        iv.isUserInteractionEnabled = false
        cell.addSubview(iv)
        if let r = it.ref {
          if let img = PFImageLoader.shared.cached(r.uri, maxPixel: side * UIScreen.main.scale) {
            iv.image = img
          } else {
            iv.alpha = 0
            PFImageLoader.shared.load(r.uri, headers: r.headers, maxPixel: side * UIScreen.main.scale) { [weak iv] img in
              guard let iv = iv else { return }
              iv.image = img
              UIView.animate(withDuration: 0.2) { iv.alpha = 1 }
            }
          }
        }
        if it.video {
          let chip = UIView(frame: CGRect(x: 6, y: side - 24, width: it.duration.isEmpty ? 22 : 58, height: 18))
          chip.backgroundColor = UIColor(white: 0, alpha: 0.55)
          chip.layer.cornerRadius = 9
          chip.isUserInteractionEnabled = false
          let play = UIImageView(image: PFIcon.image("play", size: 8, weight: .bold))
          play.tintColor = .white
          play.contentMode = .center
          play.frame = CGRect(x: 2, y: 0, width: 18, height: 18)
          chip.addSubview(play)
          if !it.duration.isEmpty {
            let d = UILabel(frame: CGRect(x: 18, y: 0, width: 36, height: 18))
            d.text = it.duration
            d.font = UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
            d.textColor = .white
            d.adjustsFontSizeToFitWidth = true
            chip.addSubview(d)
          }
          cell.addSubview(chip)
        }
        cell.isAccessibilityElement = true
        cell.accessibilityTraits = .button
        host.addSubview(cell)
      }
    }
  }

  // MARK: Layout / tamanho

  override func layoutSubviews() {
    super.layoutSubviews()
    let W = bounds.width
    if W <= 0 { return }
    if abs(W - lastWidth) > 0.5 {
      lastWidth = W
      // largura mudou (1º layout / rotação) → refaz a grade com o tamanho certo
      let fresh = UIView()
      fresh.clipsToBounds = true
      fillContent(fresh, width: W)
      content.removeFromSuperview()
      insertSubview(fresh, belowSubview: footer)
      content = fresh
    }
    tabBar.frame = CGRect(x: 0, y: 0, width: W, height: tabBarH)
    var x: CGFloat = 14
    for b in tabButtons {
      let fit = ceil(b.sizeThatFits(CGSize(width: 400, height: tabBarH)).width)
      b.frame = CGRect(x: x, y: 0, width: fit, height: tabBarH)
      x += fit + 18
    }
    let hl = 1 / UIScreen.main.scale
    tabHairline.frame = CGRect(x: 0, y: tabBarH - hl, width: W, height: hl)
    layoutUnderline(animated: false)
    let ch = contentHeight(width: W)
    content.frame = CGRect(x: 0, y: tabBarH, width: W, height: ch)
    let hasFooter = currentCount() > 0
    footer.frame = CGRect(x: 0, y: tabBarH + ch, width: W, height: footerH)
    footerLabel.frame = CGRect(x: 14, y: 0, width: W - 50, height: footerH)
    footerChevron.frame = CGRect(x: W - 34, y: 0, width: 20, height: footerH)
    reportHeight(tabBarH + ch + (hasFooter ? footerH : 0))
  }

  private func layoutUnderline(animated: Bool) {
    guard let b = tabButtons.first(where: { $0.tag < tabs.count && tabs[$0.tag].key == selected }) else {
      underline.isHidden = true
      return
    }
    underline.isHidden = false
    let f = CGRect(x: b.frame.minX, y: tabBarH - 2.5, width: b.frame.width, height: 2.5)
    if animated {
      UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0.3, options: [.beginFromCurrentState]) {
        self.underline.frame = f
      }
    } else if underline.frame.isEmpty || underline.layer.animationKeys() == nil {
      underline.frame = f
    }
  }

  private func reportHeight(_ h: CGFloat) {
    let r = ceil(h)
    guard abs(r - lastHeight) >= 0.5 else { return }
    lastHeight = r
    setStyleSize(nil, height: NSNumber(value: Float(r)))
    onHeightChange(["height": Double(r)])
  }

  // MARK: Toques

  @objc private func tabTapped(_ b: UIButton) {
    guard b.tag < tabs.count else { return }
    let key = tabs[b.tag].key
    if key == selected { return }
    UISelectionFeedbackGenerator().selectionChanged()
    selected = key
    layoutUnderline(animated: true)
    rebuildContent(animated: true)
    onTabChange(["tab": key])
  }

  @objc private func itemTapped(_ c: PFTapControl) {
    onItem(["tab": selected, "key": c.key])
  }

  @objc private func footerTapped() {
    onSeeAll(["tab": selected])
  }
}
