import ExpoModulesCore
import UIKit
import Photos
import CryptoKit

// [2026-10-15 photos-native] Grade de Fotos NATIVA (estilo Fotos do iOS / Google Fotos).
//   • itens locais enumerados aqui (PHFetchResult, sem passar 30k itens pelo JS)
//     + itens da nuvem vindos do JS (setCloudItems), mesclados por data;
//     nuvem cuja tag (md5(localIdentifier)[0:10] no nome) casa com um local
//     é escondida e o local ganha selo "na nuvem";
//   • layout analítico (PGLayout) com cabeçalhos grudados por dia/mês/ano;
//   • pinça troca o nível (colunas/agrupamento) mantendo o item sob os dedos;
//   • barra de rolagem rápida com balão de mês; seleção por long-press + arrastar;
//   • miniaturas: PHCachingImageManager (locais) / MVImageLoader (nuvem, cache em disco).
// Contrato: scratchpad photos/SPEC.md (cópia no cabeçalho de components/photos/nativePhotosGrid.js).

struct PGItem {
  var key: String
  var local: Bool
  var localId: String
  var localIndex: Int
  var cloudId: String
  var ts: Double
  var w: Int
  var h: Int
  var video: Bool
  var dur: Double
  var thumb: String
  var full: String
  var name: String
  var unavailable: Bool
  var tag: String
}

struct PGSection {
  var start: Int
  var count: Int
  var ts: Double
}

private struct PGLevel {
  var cols: Int
  var group: String // "year" | "month" | "day"
}

public final class PGGridView: ExpoView, UICollectionViewDataSource, UICollectionViewDelegate,
  UICollectionViewDataSourcePrefetching, UIGestureRecognizerDelegate, PHPhotoLibraryChangeObserver {

  let onReady = EventDispatcher()
  let onPress = EventDispatcher()
  let onZoomChange = EventDispatcher()
  let onScrollState = EventDispatcher()
  let onNativeError = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onSelectionMode = EventDispatcher()

  private let layout = PGLayout()
  private var cv: UICollectionView!
  private let scroller = PGScroller(frame: .zero)
  private let imageManager = PHCachingImageManager()
  private let dataQ = DispatchQueue(label: "br.com.chatyy.photosgrid.data", qos: .userInitiated)

  // dados (main)
  private var fetch: PHFetchResult<PHAsset>?
  private var localItems: [PGItem] = []
  private var cloudItems: [PGItem] = []
  private var items: [PGItem] = []
  private var dayKeys: [Int32] = []
  private var monthKeys: [Int32] = []
  private var yearKeys: [Int32] = []
  private var sections: [PGSection] = []
  private var keyIndex: [String: Int] = [:]
  private var matchedLocal = Set<String>()
  private var generation = 0
  private var permission = "notDetermined"
  private var observing = false
  private var reloadWork: DispatchWorkItem?
  private var titleCache: [String: String] = [:]

  // status de backup
  private var cloudSet = Set<String>()
  private var pendingSet = Set<String>()
  private var uploadingSet = Set<String>()
  private var failedSet = Set<String>()
  private var localOnlySet = Set<String>()
  private var backupEnabled = false
  private var showBadges = true

  // aparência
  private var theme = PGTheme()
  private var locale = Locale.current
  private var labels: [String: String] = [:]
  private var levels: [PGLevel] = [PGLevel(cols: 12, group: "year"), PGLevel(cols: 7, group: "month"),
                                   PGLevel(cols: 5, group: "day"), PGLevel(cols: 3, group: "day")]
  private var level = 3
  private var includeLocal = true
  private var insetTop: CGFloat = 0
  private var insetBottom: CGFloat = 0

  // seleção
  private var selecting = false
  private var selection = Set<String>()
  private var dragAnchor: Int = -1
  private var dragBase = Set<String>()
  private var dragRemoving = false
  private var dragLast: Int = -1
  private var autoScrollLink: CADisplayLink?
  private var autoScrollSpeed: CGFloat = 0
  private var lastTouch: CGPoint = .zero

  // pinça
  private var lastZoomAt: CFTimeInterval = 0
  private var lastBubbleMonth: Int32 = -1
  private var scrollingReported = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
    cv.dataSource = self
    cv.delegate = self
    cv.prefetchDataSource = self
    cv.alwaysBounceVertical = true
    cv.contentInsetAdjustmentBehavior = .never
    cv.showsVerticalScrollIndicator = false
    cv.allowsMultipleSelection = false
    cv.register(PGCell.self, forCellWithReuseIdentifier: PGCell.reuseId)
    cv.register(PGHeader.self, forSupplementaryViewOfKind: PGLayout.headerKind, withReuseIdentifier: PGHeader.reuseId)
    addSubview(cv)
    addSubview(scroller)
    scroller.onDrag = { [weak self] f in self?.scrollerDragged(f) }
    scroller.onDragState = { [weak self] active in
      guard let self = self else { return }
      self.onScrollState(["scrolling": active, "offset": Double(self.cv.contentOffset.y)])
    }

    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(onPinch(_:)))
    pinch.delegate = self
    cv.addGestureRecognizer(pinch)
    let long = UILongPressGestureRecognizer(target: self, action: #selector(onLongPress(_:)))
    long.minimumPressDuration = 0.32
    long.delegate = self
    cv.addGestureRecognizer(long)

    applyTheme()
    reloadLocal()
  }

  deinit {
    if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    autoScrollLink?.invalidate()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let oldW = cv.frame.width
    cv.frame = bounds
    cv.contentInset = UIEdgeInsets(top: insetTop, left: 0, bottom: insetBottom, right: 0)
    scroller.frame = CGRect(x: bounds.width - 220, y: insetTop + 8, width: 220, height: max(80, bounds.height - insetTop - insetBottom - 16))
    if oldW != bounds.width { layout.invalidateLayout() }
    updateScroller()
  }

  // MARK: - props

  func setTheme(_ v: [String: Any]) {
    if let c = PGTheme.color(v["background"]) { theme.background = c }
    if let c = PGTheme.color(v["text"]) { theme.text = c }
    if let c = PGTheme.color(v["textSecondary"]) { theme.textSecondary = c }
    if let c = PGTheme.color(v["accent"]) { theme.accent = c }
    if let c = PGTheme.color(v["header"]) { theme.header = c } else if let c = PGTheme.color(v["background"]) { theme.header = c }
    if let c = PGTheme.color(v["check"]) { theme.check = c } else if let c = PGTheme.color(v["accent"]) { theme.check = c }
    applyTheme()
  }

  func setDark(_ d: Bool?) {
    overrideUserInterfaceStyle = d == nil ? .unspecified : (d! ? .dark : .light)
  }

  func setLocale(_ s: String?) {
    let l = (s ?? "").replacingOccurrences(of: "_", with: "-")
    locale = l.isEmpty ? Locale.current : Locale(identifier: l)
    titleCache.removeAll()
    cv.reloadData()
  }

  func setLabels(_ v: [String: Any]?) {
    var m: [String: String] = [:]
    for (k, x) in v ?? [:] { if let s = x as? String { m[k] = s } }
    labels = m
    titleCache.removeAll()
    cv.reloadData()
  }

  func setInsets(top: Double?, bottom: Double?) {
    if let t = top { insetTop = CGFloat(t) }
    if let b = bottom { insetBottom = CGFloat(b) }
    setNeedsLayout()
  }

  func setIncludeLocal(_ v: Bool?) {
    let n = v ?? true
    if n == includeLocal { return }
    includeLocal = n
    reloadLocal()
  }

  func setBackupEnabled(_ v: Bool?) {
    backupEnabled = v ?? false
    refreshVisibleBadges()
  }

  func setShowBadges(_ v: Bool?) {
    showBadges = v ?? true
    refreshVisibleBadges()
  }

  func setZoomLevels(_ v: [[String: Any]]?) {
    guard let arr = v, !arr.isEmpty else { return }
    var out: [PGLevel] = []
    for d in arr {
      let c = max(1, min(20, (d["c"] as? NSNumber)?.intValue ?? 3))
      var g = (d["g"] as? String) ?? "day"
      if g != "year" && g != "month" { g = "day" }
      out.append(PGLevel(cols: c, group: g))
    }
    levels = out
    level = min(level, out.count - 1)
    rebuildSections(anchor: nil)
  }

  func setZoomLevel(_ v: Int?) {
    guard let n = v, n >= 0, n < levels.count, n != level else { return }
    level = n
    rebuildSections(anchor: nil)
  }

  private func applyTheme() {
    backgroundColor = theme.background
    cv.backgroundColor = theme.background
    scroller.apply(theme: theme)
    cv.reloadData()
  }

  // MARK: - dados locais

  private func authString(_ s: PHAuthorizationStatus) -> String {
    switch s {
    case .authorized: return "authorized"
    case .limited: return "limited"
    case .denied, .restricted: return "denied"
    default: return "notDetermined"
    }
  }

  func reloadLocal() {
    let st = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    permission = authString(st)
    let allowed = includeLocal && (st == .authorized || st == .limited)
    if allowed && !observing {
      PHPhotoLibrary.shared().register(self)
      observing = true
    }
    generation += 1
    let gen = generation
    dataQ.async { [weak self] in
      var res: PHFetchResult<PHAsset>?
      var list: [PGItem] = []
      if allowed {
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d",
                                     PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let r = PHAsset.fetchAssets(with: opts)
        res = r
        list.reserveCapacity(r.count)
        r.enumerateObjects { a, i, _ in
          let id = a.localIdentifier
          list.append(PGItem(key: "l:" + id, local: true, localId: id, localIndex: i, cloudId: "",
                             ts: a.creationDate?.timeIntervalSince1970 ?? 0, w: a.pixelWidth, h: a.pixelHeight,
                             video: a.mediaType == .video, dur: a.duration, thumb: "", full: "", name: "",
                             unavailable: false, tag: PGGridView.md5Tag(id)))
        }
      }
      DispatchQueue.main.async { [res, list] in // [review] captura por valor
        guard let self = self, gen == self.generation else { return }
        self.fetch = res
        self.localItems = list
        self.imageManager.stopCachingImagesForAllAssets()
        self.rebuildMerged()
      }
    }
  }

  public func photoLibraryDidChange(_ changeInstance: PHChange) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if let f = self.fetch, changeInstance.changeDetails(for: f) == nil { return }
      self.reloadWork?.cancel()
      let w = DispatchWorkItem { [weak self] in self?.reloadLocal() }
      self.reloadWork = w
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: w)
    }
  }

  static func md5Tag(_ s: String) -> String {
    let d = Insecure.MD5.hash(data: Data(s.utf8))
    var out = ""
    out.reserveCapacity(10)
    for b in d.prefix(5) { out += String(format: "%02x", b) }
    return out
  }

  private static let tagRegex = try? NSRegularExpression(pattern: "_([a-f0-9]{10})\\.[^.]+$")

  static func tagFromName(_ n: String) -> String {
    guard let re = tagRegex, let m = re.firstMatch(in: n, range: NSRange(n.startIndex..., in: n)),
          let r = Range(m.range(at: 1), in: n) else { return "" }
    return String(n[r])
  }

  // MARK: - nuvem

  func setCloudItems(_ raw: [[String: Any]], replace: Bool) {
    dataQ.async { [weak self] in
      var parsed: [PGItem] = []
      parsed.reserveCapacity(raw.count)
      for d in raw {
        let idv = d["id"]
        let id: String
        if let s = idv as? String { id = s } else if let n = idv as? NSNumber { id = n.stringValue } else { continue }
        let name = (d["n"] as? String) ?? ""
        var t = (d["t"] as? NSNumber)?.doubleValue ?? 0
        if t > 1e11 { t /= 1000 }
        parsed.append(PGItem(key: "c:" + id, local: false, localId: "", localIndex: -1, cloudId: id, ts: t,
                             w: (d["w"] as? NSNumber)?.intValue ?? 0, h: (d["h"] as? NSNumber)?.intValue ?? 0,
                             video: (d["v"] as? Bool) ?? ((d["v"] as? NSNumber)?.boolValue ?? false),
                             dur: (d["d"] as? NSNumber)?.doubleValue ?? 0,
                             thumb: (d["u"] as? String) ?? "", full: (d["f"] as? String) ?? "", name: name,
                             unavailable: (d["x"] as? Bool) ?? false, tag: PGGridView.tagFromName(name)))
      }
      DispatchQueue.main.async { [parsed] in // [review] captura por valor
        guard let self = self else { return }
        if replace {
          self.cloudItems = parsed
        } else {
          var seen = Set(self.cloudItems.map { $0.cloudId })
          for p in parsed where !seen.contains(p.cloudId) {
            self.cloudItems.append(p)
            seen.insert(p.cloudId)
          }
        }
        self.rebuildMerged()
      }
    }
  }

  // MARK: - mescla + seções

  private func rebuildMerged() {
    let anchor = currentAnchor()
    let locals = localItems
    let clouds = cloudItems
    generation += 1
    let gen = generation
    dataQ.async { [weak self] in
      var tagToLocal: [String: String] = [:]
      tagToLocal.reserveCapacity(locals.count)
      for l in locals { tagToLocal[l.tag] = l.localId }
      var matched = Set<String>()
      var visibleCloud: [PGItem] = []
      visibleCloud.reserveCapacity(clouds.count)
      for c in clouds {
        if !c.tag.isEmpty, let lid = tagToLocal[c.tag] { matched.insert(lid); continue }
        visibleCloud.append(c)
      }
      visibleCloud.sort { $0.ts > $1.ts }
      // merge de duas listas já ordenadas (desc)
      var merged: [PGItem] = []
      merged.reserveCapacity(locals.count + visibleCloud.count)
      var i = 0, j = 0
      while i < locals.count || j < visibleCloud.count {
        if j >= visibleCloud.count || (i < locals.count && locals[i].ts >= visibleCloud[j].ts) {
          merged.append(locals[i]); i += 1
        } else {
          merged.append(visibleCloud[j]); j += 1
        }
      }
      // chaves de dia/mês/ano (fuso local), calendário consultado 1x por dia distinto
      var days = [Int32](repeating: 0, count: merged.count)
      var months = [Int32](repeating: 0, count: merged.count)
      var years = [Int32](repeating: 0, count: merged.count)
      let cal = Calendar.current
      let tz = TimeZone.current
      var dayCache: [Int32: (Int32, Int32)] = [:]
      for (k, it) in merged.enumerated() {
        let date = Date(timeIntervalSince1970: it.ts)
        let off = Double(tz.secondsFromGMT(for: date))
        let day = Int32(floor((it.ts + off) / 86400))
        days[k] = day
        if let c = dayCache[day] {
          months[k] = c.0; years[k] = c.1
        } else {
          let comps = cal.dateComponents([.year, .month], from: date)
          let y = Int32(comps.year ?? 1970), m = Int32(comps.month ?? 1)
          let v = (y * 12 + (m - 1), y)
          dayCache[day] = v
          months[k] = v.0; years[k] = v.1
        }
      }
      var idx: [String: Int] = [:]
      idx.reserveCapacity(merged.count)
      for (k, it) in merged.enumerated() { idx[it.key] = k }
      DispatchQueue.main.async { [merged, days, months, years, idx, matched, visibleCloud] in // [review] captura por valor (closure @Sendable)
        guard let self = self, gen == self.generation else { return }
        self.items = merged
        self.dayKeys = days
        self.monthKeys = months
        self.yearKeys = years
        self.keyIndex = idx
        self.matchedLocal = matched
        // seleção só com chaves que ainda existem
        if !self.selection.isEmpty {
          let before = self.selection.count
          self.selection = self.selection.filter { idx[$0] != nil }
          if self.selection.count != before { self.emitSelection() }
        }
        self.rebuildSections(anchor: anchor)
        self.onReady([
          "total": merged.count, "local": locals.count, "cloud": visibleCloud.count,
          "permission": self.permission,
        ])
      }
    }
  }

  private func groupKeys() -> [Int32] {
    switch levels[level].group {
    case "year": return yearKeys
    case "month": return monthKeys
    default: return dayKeys
    }
  }

  /// Recalcula seções p/ o nível atual e recarrega mantendo `anchor` (chave, y na tela).
  private func rebuildSections(anchor: (String, CGFloat)?) {
    let keys = groupKeys()
    var secs: [PGSection] = []
    var start = 0
    var n = 0
    while n < items.count {
      let k = keys[n]
      var e = n + 1
      while e < items.count && keys[e] == k { e += 1 }
      secs.append(PGSection(start: n, count: e - n, ts: items[n].ts))
      start = e
      n = e
    }
    _ = start
    sections = secs
    let lv = levels[level]
    layout.columns = lv.cols
    layout.spacing = lv.group == "year" ? 1 : 2
    layout.headerHeight = lv.group == "day" ? 44 : (lv.group == "month" ? 48 : 52)
    layout.invalidateLayout()
    cv.reloadData()
    cv.layoutIfNeeded()
    if let anc = anchor, let gi = keyIndex[anc.0], let ip = indexPath(forGlobal: gi) {
      let screenY = anc.1
      let f = layout.frameForItem(ip)
      let maxY = max(-insetTop, cv.contentSize.height - cv.bounds.height + insetBottom)
      let y = min(maxY, max(-insetTop, f.midY - screenY))
      cv.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    }
    updateScroller()
  }

  /// Item visível mais alto (ou sob `point`) + sua posição na tela.
  private func currentAnchor(at point: CGPoint? = nil) -> (String, CGFloat)? {
    guard !items.isEmpty, cv.contentOffset.y > -insetTop + 1 || point != nil else { return nil }
    var ip: IndexPath?
    if let p = point { ip = layout.indexPath(at: p) }
    if ip == nil {
      ip = cv.indexPathsForVisibleItems.min { a, b in
        let fa = layout.frameForItem(a), fb = layout.frameForItem(b)
        return fa.minY == fb.minY ? fa.minX < fb.minX : fa.minY < fb.minY
      }
    }
    guard let i = ip else { return nil }
    let g = global(i)
    guard g >= 0 && g < items.count else { return nil }
    return (items[g].key, layout.frameForItem(i).midY - cv.contentOffset.y)
  }

  private func global(_ ip: IndexPath) -> Int {
    guard ip.section < sections.count else { return -1 }
    return sections[ip.section].start + ip.item
  }

  private func indexPath(forGlobal g: Int) -> IndexPath? {
    var lo = 0, hi = sections.count - 1
    while lo <= hi {
      let mid = (lo + hi) / 2
      let s = sections[mid]
      if g < s.start { hi = mid - 1 } else if g >= s.start + s.count { lo = mid + 1 } else {
        return IndexPath(item: g - s.start, section: mid)
      }
    }
    return nil
  }

  // MARK: - títulos

  private func title(for s: Int) -> String {
    guard s < sections.count else { return "" }
    let group = levels[level].group
    let sec = sections[s]
    let ck = "\(group)|\(Int(sec.ts / 3600))"
    if let t = titleCache[ck] { return t }
    let date = Date(timeIntervalSince1970: sec.ts)
    let cal = Calendar.current
    var t: String
    switch group {
    case "year":
      t = String(cal.component(.year, from: date))
    case "month":
      let f = DateFormatter(); f.locale = locale; f.setLocalizedDateFormatFromTemplate("MMMMyyyy")
      t = f.string(from: date)
    default:
      if cal.isDateInToday(date) {
        t = labels["today"] ?? "Hoje"
      } else if cal.isDateInYesterday(date) {
        t = labels["yesterday"] ?? "Ontem"
      } else {
        let f = DateFormatter(); f.locale = locale
        let sameYear = cal.component(.year, from: date) == cal.component(.year, from: Date())
        f.setLocalizedDateFormatFromTemplate(sameYear ? "EEEdMMM" : "EEEdMMMyyyy")
        t = f.string(from: date)
      }
    }
    if let first = t.first { t = String(first).uppercased(with: locale) + t.dropFirst() }
    titleCache[ck] = t
    return t
  }

  private func bubbleText(forGlobal g: Int) -> String {
    guard g >= 0 && g < items.count else { return "" }
    let ck = "bubble|\(monthKeys[g])"
    if let t = titleCache[ck] { return t }
    let f = DateFormatter(); f.locale = locale; f.setLocalizedDateFormatFromTemplate("MMMyyyy")
    var t = f.string(from: Date(timeIntervalSince1970: items[g].ts))
    if let first = t.first { t = String(first).uppercased(with: locale) + t.dropFirst() }
    titleCache[ck] = t
    return t
  }

  // MARK: - status

  private func badge(for it: PGItem) -> PGBadge {
    if !showBadges { return .none }
    if !it.local { return it.unavailable ? .failed : .cloudOnly }
    let id = it.localId
    if matchedLocal.contains(id) || cloudSet.contains(id) { return .cloud }
    if uploadingSet.contains(id) { return .uploading }
    if failedSet.contains(id) { return .failed }
    if localOnlySet.contains(id) { return .local }
    if pendingSet.contains(id) { return backupEnabled ? .pending : .local }
    return backupEnabled ? .pending : .local
  }

  private func statusName(_ it: PGItem) -> String {
    switch badge(for: it) {
    case .cloud: return "cloud"
    case .uploading: return "uploading"
    case .failed: return "failed"
    case .pending: return "pending"
    case .cloudOnly: return "cloudOnly"
    case .local, .none: return it.local ? "local" : "cloudOnly"
    }
  }

  func setStatuses(_ p: [String: Any], replace: Bool) {
    func list(_ k: String) -> [String]? { return (p[k] as? [Any])?.compactMap { $0 as? String } }
    if replace {
      cloudSet = Set(list("cloud") ?? [])
      pendingSet = Set(list("pending") ?? [])
      uploadingSet = Set(list("uploading") ?? [])
      failedSet = Set(list("failed") ?? [])
      localOnlySet = Set(list("local") ?? [])
    } else {
      let pairs: [(String, ReferenceWritableKeyPath<PGGridView, Set<String>>)] = [
        ("cloud", \.cloudSet), ("pending", \.pendingSet), ("uploading", \.uploadingSet),
        ("failed", \.failedSet), ("local", \.localOnlySet),
      ]
      for (k, kp) in pairs {
        guard let ids = list(k), !ids.isEmpty else { continue }
        for (_, other) in pairs where other != kp { self[keyPath: other].subtract(ids) }
        self[keyPath: kp].formUnion(ids)
      }
    }
    refreshVisibleBadges()
  }

  private func refreshVisibleBadges() {
    guard cv != nil else { return }
    for ip in cv.indexPathsForVisibleItems {
      if let cell = cv.cellForItem(at: ip) as? PGCell { configureChrome(cell, ip) }
    }
  }

  // MARK: - data source

  public func numberOfSections(in collectionView: UICollectionView) -> Int { return sections.count }

  public func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return section < sections.count ? sections[section].count : 0
  }

  private var compact: Bool { return levels[level].group == "year" || layout.side < 44 }

  private func configureChrome(_ cell: PGCell, _ ip: IndexPath) {
    let g = global(ip)
    guard g >= 0 && g < items.count else { return }
    let it = items[g]
    cell.configure(video: it.video, duration: it.dur, badge: badge(for: it), selecting: selecting,
                   selected: selection.contains(it.key), compact: compact, check: theme.check)
    cell.accessibilityLabel = it.video ? "video" : "photo"
  }

  private var thumbPixels: CGFloat {
    let px = layout.side * UIScreen.main.scale
    return px <= 160 ? 160 : (px <= 320 ? 320 : 480)
  }

  public func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: PGCell.reuseId, for: indexPath) as! PGCell
    let g = global(indexPath)
    guard g >= 0 && g < items.count else { return cell }
    let it = items[g]
    configureChrome(cell, indexPath)
    if cell.requestId != 0 { imageManager.cancelImageRequest(PHImageRequestID(cell.requestId)); cell.requestId = 0 }
    let token = cell.token
    let px = thumbPixels
    if it.local, let f = fetch, it.localIndex >= 0, it.localIndex < f.count {
      let asset = f.object(at: it.localIndex)
      let o = PHImageRequestOptions()
      o.deliveryMode = .opportunistic
      o.resizeMode = .fast
      o.isNetworkAccessAllowed = true
      let rid = imageManager.requestImage(for: asset, targetSize: CGSize(width: px, height: px), contentMode: .aspectFill, options: o) { [weak cell] img, _ in
        let apply = {
          guard let c = cell, c.token == token, let img = img else { return }
          c.imageView.image = img
        }
        if Thread.isMainThread { apply() } else { DispatchQueue.main.async(execute: apply) }
      }
      cell.requestId = Int32(rid)
    } else if !it.thumb.isEmpty {
      if let img = MVImageLoader.shared.cachedImage(it.thumb, maxPixel: px) {
        cell.imageView.image = img
      } else {
        MVImageLoader.shared.load(it.thumb, maxPixel: px) { [weak cell] img in
          guard let c = cell, c.token == token else { return }
          c.imageView.image = img
          if img != nil {
            c.imageView.alpha = 0
            UIView.animate(withDuration: 0.15) { c.imageView.alpha = 1 }
          }
        }
      }
    }
    return cell
  }

  public func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String, at indexPath: IndexPath) -> UICollectionReusableView {
    let h = collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: PGHeader.reuseId, for: indexPath) as! PGHeader
    let s = indexPath.section
    var allSel = false
    if selecting && s < sections.count {
      let sec = sections[s]
      allSel = (sec.start..<(sec.start + sec.count)).allSatisfy { selection.contains(items[$0].key) }
    }
    h.configure(title: title(for: s), theme: theme, big: levels[level].group != "day", selecting: selecting && levels[level].group == "day", allSelected: allSel)
    h.onSelectTap = { [weak self] in self?.toggleSection(s) }
    return h
  }

  public func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
    let px = thumbPixels
    var assets: [PHAsset] = []
    for ip in indexPaths {
      let g = global(ip)
      guard g >= 0 && g < items.count else { continue }
      let it = items[g]
      if it.local, let f = fetch, it.localIndex >= 0, it.localIndex < f.count {
        assets.append(f.object(at: it.localIndex))
      } else if !it.thumb.isEmpty {
        MVImageLoader.shared.prefetch(it.thumb, maxPixel: px)
      }
    }
    if !assets.isEmpty {
      let o = PHImageRequestOptions(); o.resizeMode = .fast; o.isNetworkAccessAllowed = true
      imageManager.startCachingImages(for: assets, targetSize: CGSize(width: px, height: px), contentMode: .aspectFill, options: o)
    }
  }

  public func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
    let px = thumbPixels
    var assets: [PHAsset] = []
    for ip in indexPaths {
      let g = global(ip)
      guard g >= 0 && g < items.count, items[g].local, let f = fetch, items[g].localIndex < f.count else { continue }
      assets.append(f.object(at: items[g].localIndex))
    }
    if !assets.isEmpty {
      let o = PHImageRequestOptions(); o.resizeMode = .fast; o.isNetworkAccessAllowed = true
      imageManager.stopCachingImages(for: assets, targetSize: CGSize(width: px, height: px), contentMode: .aspectFill, options: o)
    }
  }

  // MARK: - toque

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    let g = global(indexPath)
    guard g >= 0 && g < items.count else { return }
    let it = items[g]
    if selecting {
      if selection.contains(it.key) { selection.remove(it.key) } else { selection.insert(it.key) }
      if let c = collectionView.cellForItem(at: indexPath) as? PGCell {
        c.setSelectedAnimated(selection.contains(it.key), compact: compact, check: theme.check)
      }
      refreshHeader(indexPath.section)
      emitSelection()
      return
    }
    if levels[level].group == "year" {
      // ano → toque aproxima p/ o nível de mês naquele ponto (como o Google Fotos)
      let f = layout.frameForItem(indexPath)
      changeLevel(to: min(levels.count - 1, level + 1), focus: CGPoint(x: f.midX, y: f.midY))
      return
    }
    let f = layout.frameForItem(indexPath)
    let w = collectionView.convert(f, to: nil)
    let frame: [String: Any] = ["x": Double(w.minX), "y": Double(w.minY), "width": Double(w.width), "height": Double(w.height)]
    onPress(["key": it.key, "index": g, "frame": frame, "kind": it.local ? "local" : "cloud"])
  }

  // MARK: - rolagem

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    updateScroller()
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    if tallEnough { scroller.show() }
    if !scrollingReported {
      scrollingReported = true
      onScrollState(["scrolling": true, "offset": Double(scrollView.contentOffset.y)])
    }
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate { scrollEnded() }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { scrollEnded() }

  private func scrollEnded() {
    scroller.scheduleHide()
    if scrollingReported {
      scrollingReported = false
      onScrollState(["scrolling": false, "offset": Double(cv.contentOffset.y)])
    }
  }

  private var tallEnough: Bool { return cv.contentSize.height > cv.bounds.height * 4 }

  private var maxOffset: CGFloat {
    return max(0, cv.contentSize.height - cv.bounds.height + insetTop + insetBottom)
  }

  private func updateScroller() {
    guard cv != nil else { return }
    let range = maxOffset
    let f = range > 0 ? (cv.contentOffset.y + insetTop) / range : 0
    if !scroller.dragging { scroller.setFraction(max(0, min(1, f))) }
    if scroller.alpha > 0 {
      let probe = CGPoint(x: 4, y: cv.contentOffset.y + insetTop + layout.headerHeight + 4)
      var g = -1
      if let ip = layout.indexPath(at: probe) { g = global(ip) } else {
        let s = layout.sectionAt(y: probe.y)
        if s < sections.count { g = sections[s].start }
      }
      if g >= 0 {
        scroller.setBubble(bubbleText(forGlobal: g))
        if scroller.dragging && g < monthKeys.count && monthKeys[g] != lastBubbleMonth {
          lastBubbleMonth = monthKeys[g]
          UISelectionFeedbackGenerator().selectionChanged()
        }
      }
    }
  }

  private func scrollerDragged(_ f: CGFloat) {
    let y = -insetTop + f * maxOffset
    cv.setContentOffset(CGPoint(x: 0, y: y), animated: false)
    updateScroller()
  }

  // MARK: - pinça

  public func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    return g is UIPinchGestureRecognizer
  }

  @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
    guard g.state == .changed else { return }
    let now = CACurrentMediaTime()
    if now - lastZoomAt < 0.28 { return }
    var target = level
    if g.scale > 1.18 { target = min(levels.count - 1, level + 1) }
    else if g.scale < 0.85 { target = max(0, level - 1) }
    if target == level { return }
    lastZoomAt = now
    g.scale = 1
    changeLevel(to: target, focus: g.location(in: cv))
  }

  private func changeLevel(to target: Int, focus: CGPoint) {
    guard target != level, target >= 0, target < levels.count else { return }
    let anchor = currentAnchor(at: focus)
      ?? currentAnchor()
    let snap = cv.snapshotView(afterScreenUpdates: false)
    if let s = snap { s.frame = cv.frame; insertSubview(s, aboveSubview: cv) }
    level = target
    titleCache = titleCache.filter { $0.key.hasPrefix("bubble|") }
    // âncora: o mesmo item sob os dedos depois da troca
    var a = anchor
    if let anc = anchor { a = (anc.0, focus.y - cv.contentOffset.y) }
    rebuildSections(anchor: a)
    cv.alpha = 0
    cv.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
    UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
      self.cv.alpha = 1
      self.cv.transform = .identity
      snap?.alpha = 0
    } completion: { _ in
      snap?.removeFromSuperview()
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onZoomChange(["level": level])
  }

  // MARK: - seleção

  private func emitSelection() {
    let keys = Array(selection.prefix(5000))
    onSelectionChange(["count": selection.count, "keys": keys])
  }

  private func refreshHeader(_ s: Int) {
    let ip = IndexPath(item: 0, section: s)
    if let h = cv.supplementaryView(forElementKind: PGLayout.headerKind, at: ip) as? PGHeader, s < sections.count {
      let sec = sections[s]
      let all = (sec.start..<(sec.start + sec.count)).allSatisfy { selection.contains(items[$0].key) }
      h.configure(title: title(for: s), theme: theme, big: levels[level].group != "day", selecting: selecting && levels[level].group == "day", allSelected: all)
    }
  }

  private func toggleSection(_ s: Int) {
    guard selecting, s < sections.count else { return }
    let sec = sections[s]
    let keys = (sec.start..<(sec.start + sec.count)).map { items[$0].key }
    if keys.allSatisfy({ selection.contains($0) }) { selection.subtract(keys) } else { selection.formUnion(keys) }
    UISelectionFeedbackGenerator().selectionChanged()
    refreshVisibleBadges()
    refreshHeader(s)
    emitSelection()
  }

  func setSelectionMode(_ on: Bool) {
    if selecting == on { return }
    selecting = on
    if !on { selection.removeAll(); emitSelection() }
    refreshVisibleBadges()
    for ip in cv.indexPathsForVisibleSupplementaryElements(ofKind: PGLayout.headerKind) { refreshHeader(ip.section) }
    onSelectionMode(["active": on])
  }

  func clearSelection() {
    selection.removeAll()
    refreshVisibleBadges()
    for ip in cv.indexPathsForVisibleSupplementaryElements(ofKind: PGLayout.headerKind) { refreshHeader(ip.section) }
    emitSelection()
  }

  func selectAll() {
    if !selecting { setSelectionMode(true) }
    selection = Set(items.map { $0.key })
    refreshVisibleBadges()
    for ip in cv.indexPathsForVisibleSupplementaryElements(ofKind: PGLayout.headerKind) { refreshHeader(ip.section) }
    emitSelection()
  }

  func getSelection() -> [String] { return Array(selection) }

  @objc private func onLongPress(_ g: UILongPressGestureRecognizer) {
    let p = g.location(in: cv)
    lastTouch = g.location(in: self)
    switch g.state {
    case .began:
      guard let ip = layout.indexPath(at: p) else { return }
      let gi = global(ip)
      guard gi >= 0 && gi < items.count else { return }
      if !selecting { setSelectionMode(true) }
      dragAnchor = gi
      dragLast = gi
      dragBase = selection
      dragRemoving = selection.contains(items[gi].key)
      cv.isScrollEnabled = false
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      applyDragRange(to: gi)
      startAutoScroll()
    case .changed:
      updateAutoScrollSpeed()
      if let ip = layout.indexPath(at: p) {
        let gi = global(ip)
        if gi != dragLast && gi >= 0 { dragLast = gi; applyDragRange(to: gi) }
      }
    default:
      stopAutoScroll()
      cv.isScrollEnabled = true
      dragAnchor = -1
    }
  }

  private func applyDragRange(to gi: Int) {
    guard dragAnchor >= 0 else { return }
    let lo = min(dragAnchor, gi), hi = max(dragAnchor, gi)
    var next = dragBase
    for k in lo...hi where k < items.count {
      if dragRemoving { next.remove(items[k].key) } else { next.insert(items[k].key) }
    }
    if next == selection { return }
    let changed = selection.symmetricDifference(next)
    selection = next
    for ip in cv.indexPathsForVisibleItems {
      let g = global(ip)
      guard g >= 0 && g < items.count, changed.contains(items[g].key), let c = cv.cellForItem(at: ip) as? PGCell else { continue }
      c.setSelectedAnimated(selection.contains(items[g].key), compact: compact, check: theme.check)
    }
    for ip in cv.indexPathsForVisibleSupplementaryElements(ofKind: PGLayout.headerKind) { refreshHeader(ip.section) }
    emitSelection()
  }

  private func startAutoScroll() {
    autoScrollLink?.invalidate()
    let l = CADisplayLink(target: self, selector: #selector(autoScrollTick))
    l.add(to: .main, forMode: .common)
    autoScrollLink = l
    autoScrollSpeed = 0
  }

  private func stopAutoScroll() {
    autoScrollLink?.invalidate()
    autoScrollLink = nil
    autoScrollSpeed = 0
  }

  private func updateAutoScrollSpeed() {
    let edge: CGFloat = 70
    let top = insetTop + edge
    let bottom = bounds.height - insetBottom - edge
    if lastTouch.y < top { autoScrollSpeed = -min(28, (top - lastTouch.y) / 2.5) }
    else if lastTouch.y > bottom { autoScrollSpeed = min(28, (lastTouch.y - bottom) / 2.5) }
    else { autoScrollSpeed = 0 }
  }

  @objc private func autoScrollTick() {
    guard autoScrollSpeed != 0 else { return }
    let y = min(maxOffset - insetTop, max(-insetTop, cv.contentOffset.y + autoScrollSpeed))
    cv.contentOffset = CGPoint(x: 0, y: y)
    let p = convert(lastTouch, to: cv)
    if let ip = layout.indexPath(at: p) {
      let gi = global(ip)
      if gi != dragLast && gi >= 0 { dragLast = gi; applyDragRange(to: gi) }
    }
  }

  // MARK: - funções p/ o JS

  func getItems(from: Int, count: Int) -> [[String: Any]] {
    guard from >= 0, from < items.count, count > 0 else { return [] }
    let end = min(items.count, from + min(count, 2000))
    var out: [[String: Any]] = []
    out.reserveCapacity(end - from)
    for g in from..<end {
      let it = items[g]
      var d: [String: Any] = [
        "key": it.key, "type": it.video ? "video" : "image", "createdAt": it.ts * 1000,
        "width": it.w, "height": it.h, "local": it.local, "status": statusName(it), "index": g,
      ]
      if it.local {
        d["uri"] = "ph://" + it.localId
        d["thumbUri"] = "ph://" + it.localId
        d["localId"] = it.localId
      } else {
        d["uri"] = it.full.isEmpty ? it.thumb : it.full
        d["thumbUri"] = it.thumb
        d["cloudId"] = it.cloudId
        d["name"] = it.name
        d["unavailable"] = it.unavailable
      }
      if it.video { d["duration"] = it.dur }
      out.append(d)
    }
    return out
  }

  func indexOfKey(_ key: String) -> Int { return keyIndex[key] ?? -1 }

  func frameForKey(_ key: String) -> [String: Any]? {
    guard let g = keyIndex[key], let ip = indexPath(forGlobal: g) else { return nil }
    let f = layout.frameForItem(ip)
    let visible = CGRect(x: 0, y: cv.contentOffset.y + insetTop + layout.headerHeight, width: cv.bounds.width,
                         height: cv.bounds.height - insetTop - insetBottom - layout.headerHeight)
    guard visible.intersects(f) else { return nil }
    let w = cv.convert(f, to: nil)
    return ["x": Double(w.minX), "y": Double(w.minY), "width": Double(w.width), "height": Double(w.height)]
  }

  func scrollToKey(_ key: String, animated: Bool) -> Bool {
    guard let g = keyIndex[key], let ip = indexPath(forGlobal: g) else { return false }
    let f = layout.frameForItem(ip)
    let visible = CGRect(x: 0, y: cv.contentOffset.y + insetTop + layout.headerHeight, width: cv.bounds.width,
                         height: cv.bounds.height - insetTop - insetBottom - layout.headerHeight)
    if visible.contains(f) { return true }
    let y = min(maxOffset - insetTop, max(-insetTop, f.midY - (cv.bounds.height + insetTop - insetBottom) / 2))
    cv.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
    return true
  }

  func scrollToTop(_ animated: Bool) {
    cv.setContentOffset(CGPoint(x: 0, y: -insetTop), animated: animated)
  }
}
