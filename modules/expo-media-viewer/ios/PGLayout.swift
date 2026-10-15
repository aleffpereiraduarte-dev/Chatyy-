import UIKit

// [2026-10-15 photos-native] Layout da grade de Fotos: geometria ANALÍTICA
// (linhas uniformes por seção) → custo O(seções) no prepare e O(visível) por
// frame, independente de 50k itens. Cabeçalhos grudados calculados aqui.
final class PGLayout: UICollectionViewLayout {
  var columns: Int = 3 { didSet { if columns != oldValue { dirty = true } } }
  var spacing: CGFloat = 2 { didSet { if spacing != oldValue { dirty = true } } }
  var headerHeight: CGFloat = 44 { didSet { if headerHeight != oldValue { dirty = true } } }
  var sectionGap: CGFloat = 0
  var topInset: CGFloat = 0 { didSet { if topInset != oldValue { dirty = true } } }
  var bottomInset: CGFloat = 0 { didSet { if bottomInset != oldValue { dirty = true } } }

  private var dirty = true
  private var lastWidth: CGFloat = 0
  private(set) var side: CGFloat = 0
  private var counts: [Int] = []
  private var tops: [CGFloat] = []      // y do cabeçalho de cada seção
  private var heights: [CGFloat] = []   // altura total da seção (cabeçalho + linhas)
  private var contentHeight: CGFloat = 0

  static let headerKind = UICollectionView.elementKindSectionHeader

  override func invalidateLayout(with context: UICollectionViewLayoutInvalidationContext) {
    if context.invalidateEverything || context.invalidateDataSourceCounts { dirty = true }
    super.invalidateLayout(with: context)
  }

  override func prepare() {
    super.prepare()
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    if !dirty && w == lastWidth { return }
    dirty = false
    lastWidth = w
    let c = CGFloat(max(1, columns))
    side = max(1, floor((w - spacing * (c - 1)) / c * 2) / 2)
    let n = cv.numberOfSections
    counts = (0..<n).map { cv.numberOfItems(inSection: $0) }
    tops = []
    heights = []
    tops.reserveCapacity(n)
    heights.reserveCapacity(n)
    var y = topInset
    for i in 0..<n {
      let rows = (counts[i] + columns - 1) / max(1, columns)
      let h = headerHeight + CGFloat(rows) * side + CGFloat(max(0, rows - 1)) * spacing + sectionGap
      tops.append(y)
      heights.append(h)
      y += h + (i < n - 1 ? spacing : 0)
    }
    contentHeight = y + bottomInset
  }

  override var collectionViewContentSize: CGSize {
    return CGSize(width: collectionView?.bounds.width ?? 0, height: contentHeight)
  }

  override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
    // muda a largura → recalcula; só o offset → reposiciona cabeçalhos grudados
    if newBounds.width != lastWidth { dirty = true }
    return true
  }

  // MARK: - geometria

  func sectionTop(_ s: Int) -> CGFloat { return s < tops.count ? tops[s] : 0 }
  func sectionBottom(_ s: Int) -> CGFloat { return s < tops.count ? tops[s] + heights[s] : 0 }
  var sectionCount: Int { return tops.count }

  /// Primeira seção cujo fundo passa de y.
  func sectionAt(y: CGFloat) -> Int {
    var lo = 0, hi = tops.count - 1, ans = max(0, tops.count - 1)
    while lo <= hi {
      let mid = (lo + hi) / 2
      if tops[mid] + heights[mid] >= y { ans = mid; hi = mid - 1 } else { lo = mid + 1 }
    }
    return ans
  }

  func frameForItem(_ ip: IndexPath) -> CGRect {
    guard ip.section < tops.count else { return .zero }
    let row = ip.item / max(1, columns)
    let col = ip.item % max(1, columns)
    let x = CGFloat(col) * (side + spacing)
    let y = tops[ip.section] + headerHeight + CGFloat(row) * (side + spacing)
    return CGRect(x: x, y: y, width: side, height: side)
  }

  /// Item sob o ponto (coordenadas do conteúdo); nil = cabeçalho/vão.
  func indexPath(at p: CGPoint) -> IndexPath? {
    guard !tops.isEmpty, side > 0 else { return nil }
    let s = sectionAt(y: p.y)
    let localY = p.y - tops[s] - headerHeight
    if localY < 0 { return nil }
    let row = Int(localY / (side + spacing))
    let col = min(columns - 1, max(0, Int(p.x / (side + spacing))))
    let item = row * columns + col
    guard item < counts[s] else { return nil }
    return IndexPath(item: item, section: s)
  }

  private func headerAttrs(_ s: Int) -> UICollectionViewLayoutAttributes {
    let a = UICollectionViewLayoutAttributes(forSupplementaryViewOfKind: PGLayout.headerKind, with: IndexPath(item: 0, section: s))
    let w = collectionView?.bounds.width ?? 0
    var y = tops[s]
    if let cv = collectionView {
      let pinY = cv.contentOffset.y + cv.adjustedContentInset.top + topInset
      y = min(max(tops[s], pinY), tops[s] + heights[s] - headerHeight)
    }
    a.frame = CGRect(x: 0, y: y, width: w, height: headerHeight)
    a.zIndex = 10
    return a
  }

  override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
    guard !tops.isEmpty else { return [] }
    var out: [UICollectionViewLayoutAttributes] = []
    var s = sectionAt(y: rect.minY)
    while s < tops.count && tops[s] <= rect.maxY {
      out.append(headerAttrs(s))
      let gridTop = tops[s] + headerHeight
      let rowH = side + spacing
      let firstRow = max(0, Int(floor((rect.minY - gridTop) / rowH)))
      let lastRow = Int(floor((rect.maxY - gridTop) / rowH))
      if lastRow >= firstRow {
        let start = firstRow * columns
        let end = min(counts[s], (lastRow + 1) * columns)
        if start < end {
          for i in start..<end {
            let ip = IndexPath(item: i, section: s)
            let a = UICollectionViewLayoutAttributes(forCellWith: ip)
            a.frame = frameForItem(ip)
            out.append(a)
          }
        }
      }
      s += 1
    }
    return out
  }

  override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard indexPath.section < tops.count, indexPath.item < counts[indexPath.section] else { return nil }
    let a = UICollectionViewLayoutAttributes(forCellWith: indexPath)
    a.frame = frameForItem(indexPath)
    return a
  }

  override func layoutAttributesForSupplementaryView(ofKind elementKind: String, at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard elementKind == PGLayout.headerKind, indexPath.section < tops.count else { return nil }
    return headerAttrs(indexPath.section)
  }
}
