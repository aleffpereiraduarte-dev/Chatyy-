import UIKit

// [2026-10-18 tg-viewer] Faixa de miniaturas do viewer (Telegram): aparece
// quando há mais de uma mídia; a atual fica nítida com borda branca e centrada,
// as outras esmaecidas. Toque = pula para a página.

final class MVThumbCell: UICollectionViewCell {
  static let reuseId = "MVThumbCell"
  let imageView = UIImageView()
  private let playGlyph = UIImageView()
  var token = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    contentView.backgroundColor = UIColor(white: 1, alpha: 0.10)
    contentView.layer.cornerRadius = 5
    if #available(iOS 13.0, *) { contentView.layer.cornerCurve = .continuous }
    contentView.clipsToBounds = true
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.frame = contentView.bounds
    imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    contentView.addSubview(imageView)
    let cfg = UIImage.SymbolConfiguration(pointSize: 10, weight: .bold)
    playGlyph.image = UIImage(systemName: "play.fill", withConfiguration: cfg)
    playGlyph.tintColor = .white
    playGlyph.layer.shadowColor = UIColor.black.cgColor
    playGlyph.layer.shadowOpacity = 0.5
    playGlyph.layer.shadowRadius = 2
    playGlyph.layer.shadowOffset = .zero
    playGlyph.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(playGlyph)
    NSLayoutConstraint.activate([
      playGlyph.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 4),
      playGlyph.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -3),
    ])
    contentView.layer.borderColor = UIColor.white.cgColor
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    token += 1
    imageView.image = nil
  }

  func setCurrent(_ on: Bool) {
    contentView.layer.borderWidth = on ? 2 : 0
    contentView.alpha = on ? 1 : 0.55
  }

  func configure(_ item: MVItem) {
    token += 1
    let t = token
    playGlyph.isHidden = !item.isVideo
    var src = item.thumbUri
    if src.isEmpty && !item.isVideo {
      src = MVItem.existingFileURL(item.localUri) != nil ? item.localUri : item.uri
    }
    guard !src.isEmpty else { return }
    let loader = MVImageLoader.shared
    if let img = loader.cachedImage(src, maxPixel: MVImageLoader.thumbMaxPixel) {
      imageView.image = img
      return
    }
    loader.load(src, maxPixel: MVImageLoader.thumbMaxPixel) { [weak self] img in
      guard let self = self, self.token == t, let img = img else { return }
      self.imageView.image = img
    }
  }
}

final class MVThumbStrip: UIView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  static let height: CGFloat = 44
  private static let cellSize = CGSize(width: 32, height: 44)

  var onSelect: ((Int) -> Void)?
  private var items: [MVItem] = []
  private(set) var current = 0
  private let layout = UICollectionViewFlowLayout()
  private var cv: UICollectionView!
  private var lastWidth: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    setup()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    setup()
  }

  private func setup() {
    layout.scrollDirection = .horizontal
    layout.minimumLineSpacing = 3
    layout.minimumInteritemSpacing = 0
    layout.itemSize = MVThumbStrip.cellSize
    cv = UICollectionView(frame: bounds, collectionViewLayout: layout)
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.backgroundColor = .clear
    cv.showsHorizontalScrollIndicator = false
    cv.alwaysBounceHorizontal = true
    cv.decelerationRate = .fast
    cv.contentInsetAdjustmentBehavior = .never
    cv.register(MVThumbCell.self, forCellWithReuseIdentifier: MVThumbCell.reuseId)
    cv.dataSource = self
    cv.delegate = self
    addSubview(cv)
  }

  func setItems(_ list: [MVItem], current idx: Int) {
    items = list
    current = max(0, min(list.count - 1, idx))
    cv.reloadData()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let w = bounds.width
    guard w > 0, w != lastWidth else { return }
    lastWidth = w
    // Insets laterais = metade da largura → a 1ª e a última também centralizam.
    let side = max(0, (w - MVThumbStrip.cellSize.width) / 2)
    layout.sectionInset = UIEdgeInsets(top: 0, left: side, bottom: 0, right: side)
    layout.invalidateLayout()
    cv.layoutIfNeeded()
    centerCurrent(animated: false)
  }

  func setCurrent(_ idx: Int, animated: Bool) {
    guard idx >= 0, idx < items.count else { return }
    if idx == current { return }
    current = idx
    for c in cv.visibleCells {
      guard let tc = c as? MVThumbCell, let ip = cv.indexPath(for: tc) else { continue }
      tc.setCurrent(ip.item == current)
    }
    centerCurrent(animated: animated)
  }

  private func centerCurrent(animated: Bool) {
    guard current < items.count, cv.bounds.width > 0, !cv.isDragging else { return }
    let ip = IndexPath(item: current, section: 0)
    guard let attrs = cv.layoutAttributesForItem(at: ip) else { return }
    let maxX = max(0, cv.contentSize.width - cv.bounds.width)
    let x = max(0, min(maxX, attrs.frame.midX - cv.bounds.width / 2))
    cv.setContentOffset(CGPoint(x: x, y: 0), animated: animated)
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return items.count
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: MVThumbCell.reuseId, for: indexPath) as! MVThumbCell
    cell.configure(items[indexPath.item])
    cell.setCurrent(indexPath.item == current)
    return cell
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    let i = indexPath.item
    guard i != current else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    onSelect?(i)
  }
}
