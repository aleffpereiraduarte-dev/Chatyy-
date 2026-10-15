import ExpoModulesCore
import UIKit

// [2026-10-15 native-group-create] Fileira de membros SELECIONADOS do Novo
// grupo (estilo WhatsApp): UICollectionView horizontal + diffable data source.
// Cada chip = avatar (mesmo CLAvatarView da lista) + bolinha "x" + primeiro
// nome. Entrada: mola (0.3 → 1) e a fileira rola até o novo; saída: o diffable
// encolhe/funde e os vizinhos deslizam. Toque = haptic + onChipPress {id}
// (o JS remove da seleção; a lista de contatos desmarca junto).
// Mesmo contrato do Android (ChatyyChipStripView.kt).

final class CTChipCell: UICollectionViewCell {
  static let avatarSide: CGFloat = 52
  let avatar = CLAvatarView()
  private let badge = UIView()
  private let xGlyph = UIImageView()
  private let nameLabel = UILabel()
  private(set) var chipId = ""

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = false
    clipsToBounds = false
    avatar.isUserInteractionEnabled = false
    avatar.boxSize = CTChipCell.avatarSide
    contentView.addSubview(avatar)
    badge.isUserInteractionEnabled = false
    badge.layer.borderWidth = 2
    badge.layer.cornerRadius = 11
    badge.clipsToBounds = true
    contentView.addSubview(badge)
    xGlyph.contentMode = .center
    badge.addSubview(xGlyph)
    nameLabel.textAlignment = .center
    nameLabel.lineBreakMode = .byTruncatingTail
    nameLabel.numberOfLines = 1
    nameLabel.font = UIFont.systemFont(ofSize: 12, weight: .regular)
    contentView.addSubview(nameLabel)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(id: String, title: String, tiles: [Any], theme: CLTheme, colors: ChipColors, removeLabel: String) {
    chipId = id
    var d: [String: Any] = ["id": id, "kind": "direct", "title": title]
    d["tiles"] = tiles
    avatar.boxSize = CTChipCell.avatarSide
    avatar.configure(CLRow(d), theme: theme, rowBackground: colors.bg)
    badge.backgroundColor = colors.badgeBg
    badge.layer.borderColor = colors.bg.cgColor
    xGlyph.image = CLSymbols.image("xmark", pointSize: 9, weight: .bold, color: colors.badgeFg)
    nameLabel.textColor = colors.text
    nameLabel.text = CTChipCell.firstName(title)
    accessibilityLabel = removeLabel.isEmpty ? title : "\(removeLabel) \(title)"
    setNeedsLayout()
  }

  static func firstName(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return "" }
    let local = t.contains("@") ? String(t.split(separator: "@").first ?? Substring(t)) : t
    return String(local.split(separator: " ").first ?? Substring(local))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    let side = CTChipCell.avatarSide
    let ax = (b.width - side) / 2
    avatar.frame = CGRect(x: ax, y: 6, width: side, height: side)
    badge.frame = CGRect(x: ax + side - 18, y: 6 + side - 20, width: 22, height: 22)
    xGlyph.frame = badge.bounds
    nameLabel.frame = CGRect(x: 0, y: 6 + side + 4, width: b.width, height: 16)
  }

  override var isHighlighted: Bool {
    didSet {
      UIView.animate(withDuration: 0.12, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        self.contentView.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.92, y: 0.92) : .identity
      }, completion: nil)
    }
  }

  /// Entrada estilo WhatsApp: cresce com mola.
  func playEntrance() {
    contentView.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
    contentView.alpha = 0
    UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.62, initialSpringVelocity: 0.7,
                   options: [.allowUserInteraction, .beginFromCurrentState], animations: {
      self.contentView.transform = .identity
      self.contentView.alpha = 1
    }, completion: nil)
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    contentView.layer.removeAllAnimations()
    contentView.transform = .identity
    contentView.alpha = 1
  }
}

struct ChipColors {
  var bg: UIColor
  var text: UIColor
  var badgeBg: UIColor
  var badgeFg: UIColor

  init(_ d: [String: Any]?, dark: Bool) {
    let m = d ?? [:]
    bg = CTColor.of(m["bg"]) ?? (dark ? .black : .white)
    text = CTColor.of(m["text"]) ?? (dark ? UIColor(clHex: 0xF5F5F7) : UIColor(clHex: 0x111111))
    badgeBg = CTColor.of(m["badgeBg"]) ?? (dark ? UIColor(clHex: 0x48484A) : UIColor(clHex: 0x8E8E93))
    badgeFg = CTColor.of(m["badgeFg"]) ?? .white
  }
}

public final class ChatyyChipStripView: ExpoView, UICollectionViewDelegate {
  let onChipPress = EventDispatcher()
  let onNativeError = EventDispatcher()

  private var collectionView: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var items: [String: [String: Any]] = [:]
  private var order: [String] = []
  private var pending: [[String: Any]]?
  private var dark = false
  private var colorsDict: [String: Any]?
  private var colors = ChipColors(nil, dark: false)
  private var theme = CLTheme(dark: false)
  private var styleDirty = true
  private var appliedOnce = false
  private var justAdded = Set<String>()
  private var removeLabel = ""

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    let layout = UICollectionViewFlowLayout()
    layout.scrollDirection = .horizontal
    layout.itemSize = CGSize(width: 66, height: 84)
    layout.minimumLineSpacing = 2
    layout.minimumInteritemSpacing = 0
    layout.sectionInset = UIEdgeInsets(top: 2, left: 10, bottom: 0, right: 10)
    let cv = UICollectionView(frame: bounds, collectionViewLayout: layout)
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.showsHorizontalScrollIndicator = false
    cv.alwaysBounceHorizontal = true
    cv.contentInsetAdjustmentBehavior = .never
    cv.delaysContentTouches = false
    cv.backgroundColor = .clear
    cv.delegate = self
    addSubview(cv)
    collectionView = cv

    let reg = UICollectionView.CellRegistration<CTChipCell, String> { [weak self] cell, _, id in
      guard let self = self, let d = self.items[id] else { return }
      cell.configure(
        id: id,
        title: CLVal.str(d["t"]),
        tiles: (d["tiles"] as? [Any]) ?? [],
        theme: self.theme,
        colors: self.colors,
        removeLabel: self.removeLabel
      )
      if self.justAdded.remove(id) != nil { cell.playEntrance() }
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: cv) { collectionView, indexPath, id in
      return collectionView.dequeueConfiguredReusableCell(using: reg, for: indexPath, item: id)
    }
  }

  // MARK: Props

  func setItems(_ list: [[String: Any]]) { pending = list }

  func setColors(_ d: [String: Any]?) {
    colorsDict = d
    if let l = d?["removeLabel"] as? String { removeLabel = l }
    styleDirty = true
  }

  func setDark(_ v: Bool) {
    if v == dark && appliedOnce { return }
    dark = v
    styleDirty = true
  }

  func commitProps() {
    var reconfigureAll = false
    if styleDirty {
      styleDirty = false
      theme = CLTheme(dark: dark)
      colors = ChipColors(colorsDict, dark: dark)
      backgroundColor = colors.bg
      reconfigureAll = appliedOnce
    }
    apply(reconfigureAll: reconfigureAll)
  }

  private func apply(reconfigureAll: Bool) {
    let list = pending
    pending = nil
    if list == nil && !reconfigureAll { return }
    var next: [String: [String: Any]] = items
    var ids: [String] = order
    var changed: [String] = []
    if let list = list {
      next = [:]
      ids = []
      for d in list {
        let id = CLVal.str(d["id"])
        if id.isEmpty || next[id] != nil { continue }
        next[id] = d
        ids.append(id)
        if let old = items[id], CLVal.str(old["t"]) != CLVal.str(d["t"]) || String(describing: old["tiles"]) != String(describing: d["tiles"]) {
          changed.append(id)
        }
      }
    }
    let oldSet = Set(order)
    let added = ids.filter { !oldSet.contains($0) }
    items = next
    order = ids
    var snap = NSDiffableDataSourceSnapshot<Int, String>()
    snap.appendSections([0])
    snap.appendItems(ids, toSection: 0)
    let reconf = reconfigureAll ? ids.filter { oldSet.contains($0) } : changed
    if !reconf.isEmpty { snap.reconfigureItems(reconf) }
    let animate = appliedOnce && window != nil
    if animate { for id in added { justAdded.insert(id) } }
    appliedOnce = true
    dataSource.apply(snap, animatingDifferences: animate) { [weak self] in
      guard let self = self else { return }
      // Novo no fim → rola até ele (como o WhatsApp).
      if animate, let last = added.last, last == ids.last, let ip = self.dataSource.indexPath(for: last) {
        self.collectionView.scrollToItem(at: ip, at: .right, animated: true)
      }
    }
  }

  // MARK: Delegate

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onChipPress(["id": id])
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
  }
}
