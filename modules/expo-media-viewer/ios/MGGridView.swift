import ExpoModulesCore
import UIKit
import AVFoundation
import CryptoKit

// [2026-10-16 native-media-grid] Grade NATIVA genérica de miniaturas por URL
// (view `ChatyyMediaGrid`): perfil (posts/reels/lives/mídia) e "Mídia, links e
// docs" da conversa. Mora no pod do expo-media-viewer p/ reaproveitar o
// MVImageLoader (cache memória+disco, decodificação fora da main).
//   • seções por mês opcionais (cabeçalho "Outubro de 2026");
//   • selos: chip topo-esq. (c/ ponto vermelho), ícone topo-dir. (vídeo/play/
//     carrossel), contagem baixo-esq. (▶ 1,2K), duração baixo-dir.;
//   • vídeo sem pôster: 1º quadro + duração via AVAssetImageGenerator (cache);
//   • seleção nativa (toque longo entra; toque alterna) → onSelectionChange;
//   • filhos RN: 0 = cabeçalho (rola junto, acima da grade), 1 = rodapé.
// Props idempotentes (o Fabric reaplica todas a cada update): lista igual →
// nada de reloadData; célula mantém a imagem do mesmo URI (sem piscar).
// JS: components/media/NativeMediaGrid.js.

// MARK: - Modelo

struct MGItem {
  let key: String
  let uri: String
  let videoUri: String
  let isVideo: Bool
  let tl: String
  let tlDot: Bool
  let tr: String
  let bl: String
  let blPlay: Bool
  let br: String
  let autoDuration: Bool
  let ts: Double
  let isCreate: Bool
  let createLabel: String
  let a11y: String
  let sig: String

  init?(_ m: [String: Any]) {
    func s(_ k: String) -> String {
      if let v = m[k] as? String { return v }
      if let v = m[k] as? NSNumber { return v.stringValue }
      return ""
    }
    func b(_ k: String) -> Bool {
      if let v = m[k] as? Bool { return v }
      if let v = m[k] as? NSNumber { return v.boolValue }
      return false
    }
    key = s("k")
    if key.isEmpty { return nil }
    uri = s("u")
    videoUri = s("vu")
    isVideo = b("v")
    tl = s("tl")
    tlDot = b("tld")
    tr = s("tr")
    bl = s("bl")
    blPlay = b("blp")
    br = s("br")
    autoDuration = b("ad")
    if let n = m["t"] as? NSNumber { ts = n.doubleValue } else { ts = 0 }
    isCreate = b("create")
    createLabel = s("cl")
    a11y = s("a")
    sig = [key, uri, videoUri, isVideo ? "1" : "0", tl, tlDot ? "1" : "0", tr, bl, blPlay ? "1" : "0", br,
           autoDuration ? "1" : "0", String(Int64(ts / 86_400_000)), isCreate ? "1" : "0", createLabel, a11y].joined(separator: "\u{1}")
  }
}

struct MGSection {
  let title: String
  var items: [MGItem]
}

enum MGColor {
  static func parse(_ v: Any?) -> UIColor? {
    guard var s = v as? String else { return nil }
    s = s.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard s.count == 6 || s.count == 8, let n = UInt64(s, radix: 16) else { return nil }
    if s.count == 8 {
      return UIColor(red: CGFloat((n >> 24) & 0xff) / 255, green: CGFloat((n >> 16) & 0xff) / 255,
                     blue: CGFloat((n >> 8) & 0xff) / 255, alpha: CGFloat(n & 0xff) / 255)
    }
    return UIColor(red: CGFloat((n >> 16) & 0xff) / 255, green: CGFloat((n >> 8) & 0xff) / 255,
                   blue: CGFloat(n & 0xff) / 255, alpha: 1)
  }
}

// MARK: - 1º quadro + duração de vídeo (cache memória + disco)

final class MGVideoThumbs {
  static let shared = MGVideoThumbs()

  private let memory = NSCache<NSString, UIImage>()
  private var durations: [String: Double] = [:] // só na main
  private var waiters: [String: [(UIImage?, Double) -> Void]] = [:] // só na main
  private let queue: OperationQueue
  private let dir: URL

  private init() {
    memory.countLimit = 300
    queue = OperationQueue()
    queue.maxConcurrentOperationCount = 2
    queue.qualityOfService = .utility
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    dir = base.appendingPathComponent("chatyy-media-grid", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  }

  private static func hash(_ s: String) -> String {
    let d = SHA256.hash(data: Data(MVImageLoader.stableURI(s).utf8))
    return d.prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  func cachedImage(_ url: String) -> UIImage? { memory.object(forKey: url as NSString) }
  func cachedDuration(_ url: String) -> Double? { durations[url] }

  /// completion na main. duração 0 = desconhecida.
  func load(_ url: String, maxPixel: CGFloat, _ done: @escaping (UIImage?, Double) -> Void) {
    if url.isEmpty { done(nil, 0); return }
    if let img = memory.object(forKey: url as NSString) { done(img, durations[url] ?? 0); return }
    if waiters[url] != nil { waiters[url]?.append(done); return }
    waiters[url] = [done]
    let h = MGVideoThumbs.hash(url)
    let imgFile = dir.appendingPathComponent(h + ".jpg")
    let durFile = dir.appendingPathComponent(h + ".dur")
    queue.addOperation { [weak self] in
      var img: UIImage?
      var dur: Double = 0
      if let data = try? Data(contentsOf: imgFile), let im = UIImage(data: data) {
        img = im
        if let ds = try? String(contentsOf: durFile, encoding: .utf8), let dv = Double(ds) { dur = dv }
      } else if let u = MGVideoThumbs.toURL(url) {
        let asset = AVURLAsset(url: u, options: [AVURLAssetPreferPreciseDurationAndTimingKey: false])
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: maxPixel, height: maxPixel)
        gen.requestedTimeToleranceBefore = CMTime(seconds: 1, preferredTimescale: 600)
        gen.requestedTimeToleranceAfter = CMTime(seconds: 1, preferredTimescale: 600)
        if let cg = try? gen.copyCGImage(at: CMTime(seconds: 0.1, preferredTimescale: 600), actualTime: nil) {
          img = UIImage(cgImage: cg)
        }
        let secs = CMTimeGetSeconds(asset.duration)
        if secs.isFinite && secs > 0 { dur = secs }
        if let im = img, let jpg = im.jpegData(compressionQuality: 0.8) {
          try? jpg.write(to: imgFile, options: .atomic)
          if dur > 0 { try? String(dur).write(to: durFile, atomically: true, encoding: .utf8) }
        }
      }
      DispatchQueue.main.async {
        guard let self = self else { return }
        if let im = img { self.memory.setObject(im, forKey: url as NSString) }
        if dur > 0 { self.durations[url] = dur }
        let list = self.waiters.removeValue(forKey: url) ?? []
        for cb in list { cb(img, dur) }
      }
    }
  }

  private static func toURL(_ s: String) -> URL? {
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    return URL(string: s)
  }

  static func format(_ secs: Double) -> String {
    let t = Int(secs.rounded())
    if t >= 3600 { return String(format: "%d:%02d:%02d", t / 3600, (t % 3600) / 60, t % 60) }
    return String(format: "%d:%02d", t / 60, t % 60)
  }
}

// MARK: - Célula

final class MGCell: UICollectionViewCell {
  static let reuseId = "MGCell"

  let thumbView = UIImageView()
  private let placeholderIcon = UIImageView()
  private let gradientLayer = CAGradientLayer()
  private let tlChip = UIView()
  private let tlDotView = UIView()
  private let tlLabel = UILabel()
  private let trBadge = UIView()
  private let trIcon = UIImageView()
  private let blIcon = UIImageView()
  private let blLabel = UILabel()
  private let brChip = UIView()
  private let brLabel = UILabel()
  private let checkView = UIImageView()
  private let dimView = UIView()
  private let createIcon = UIImageView()
  private let createLabelView = UILabel()

  private(set) var mgKey = ""
  private(set) var mgUri = ""
  private var item: MGItem?
  private var selectionOn = false
  private var selectedOn = false
  private var autoBr = ""
  var cornerRadiusValue: CGFloat = 0 { didSet { contentView.layer.cornerRadius = cornerRadiusValue } }

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = true
    if #available(iOS 13.0, *) { contentView.layer.cornerCurve = .continuous }

    thumbView.contentMode = .scaleAspectFill
    thumbView.clipsToBounds = true
    contentView.addSubview(thumbView)

    placeholderIcon.contentMode = .center
    placeholderIcon.tintColor = UIColor(white: 1, alpha: 0.6)
    placeholderIcon.image = UIImage(systemName: "photo", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
    contentView.addSubview(placeholderIcon)

    gradientLayer.colors = [UIColor(white: 0, alpha: 0).cgColor, UIColor(white: 0, alpha: 0.5).cgColor]
    gradientLayer.isHidden = true
    contentView.layer.addSublayer(gradientLayer)

    tlChip.backgroundColor = UIColor(white: 0, alpha: 0.55)
    tlChip.layer.cornerRadius = 4
    tlDotView.backgroundColor = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)
    tlDotView.layer.cornerRadius = 3
    tlLabel.font = .systemFont(ofSize: 10, weight: .heavy)
    tlLabel.textColor = .white
    tlChip.addSubview(tlDotView)
    tlChip.addSubview(tlLabel)
    contentView.addSubview(tlChip)

    trBadge.backgroundColor = UIColor(white: 0, alpha: 0.38)
    trBadge.layer.cornerRadius = 11
    trIcon.tintColor = .white
    trIcon.contentMode = .center
    trBadge.addSubview(trIcon)
    contentView.addSubview(trBadge)

    blIcon.tintColor = .white
    blIcon.contentMode = .center
    blIcon.image = UIImage(systemName: "play.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .bold))
    blLabel.font = .systemFont(ofSize: 12, weight: .bold)
    blLabel.textColor = .white
    blLabel.layer.shadowColor = UIColor.black.cgColor
    blLabel.layer.shadowOpacity = 0.5
    blLabel.layer.shadowRadius = 2
    blLabel.layer.shadowOffset = .zero
    contentView.addSubview(blIcon)
    contentView.addSubview(blLabel)

    brChip.backgroundColor = UIColor(white: 0, alpha: 0.55)
    brChip.layer.cornerRadius = 4
    brLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .bold)
    brLabel.textColor = .white
    brChip.addSubview(brLabel)
    contentView.addSubview(brChip)

    dimView.backgroundColor = UIColor(white: 1, alpha: 0.28)
    dimView.isHidden = true
    contentView.addSubview(dimView)

    checkView.contentMode = .scaleAspectFit
    checkView.isHidden = true
    contentView.addSubview(checkView)

    createIcon.contentMode = .center
    createIcon.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 24, weight: .semibold))
    createLabelView.font = .systemFont(ofSize: 13, weight: .bold)
    createLabelView.textAlignment = .center
    contentView.addSubview(createIcon)
    contentView.addSubview(createLabelView)

    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ it: MGItem, cellPixels: CGFloat, placeholder: UIColor, createBg: UIColor, createFg: UIColor,
                 selectionOn: Bool, selected: Bool) {
    item = it
    mgKey = it.key
    self.selectionOn = selectionOn
    self.selectedOn = selected
    accessibilityLabel = it.a11y.isEmpty ? nil : it.a11y

    if it.isCreate {
      contentView.backgroundColor = createBg
      thumbView.image = nil
      thumbView.isHidden = true
      placeholderIcon.isHidden = true
      createIcon.isHidden = false
      createLabelView.isHidden = false
      createIcon.tintColor = createFg
      createLabelView.textColor = createFg
      createLabelView.text = it.createLabel
      contentView.layer.borderWidth = 1 / UIScreen.main.scale
      contentView.layer.borderColor = createFg.withAlphaComponent(0.15).cgColor
      [tlChip, trBadge, blIcon, blLabel, brChip, checkView, dimView].forEach { $0.isHidden = true }
      gradientLayer.isHidden = true
      mgUri = ""
      setNeedsLayout()
      return
    }
    contentView.layer.borderWidth = 0
    createIcon.isHidden = true
    createLabelView.isHidden = true
    thumbView.isHidden = false
    contentView.backgroundColor = placeholder

    // Imagem: mesmo URI → mantém (sem piscar em reload).
    let useVideoFrame = it.uri.isEmpty && it.isVideo && !it.videoUri.isEmpty
    let src = useVideoFrame ? ("vf:" + it.videoUri) : it.uri
    autoBr = ""
    if src != mgUri || thumbView.image == nil {
      mgUri = src
      if src.isEmpty {
        thumbView.image = nil
      } else if useVideoFrame {
        if let img = MGVideoThumbs.shared.cachedImage(it.videoUri) {
          thumbView.image = img
        } else {
          thumbView.image = nil
          let want = src
          MGVideoThumbs.shared.load(it.videoUri, maxPixel: cellPixels) { [weak self] img, dur in
            guard let self = self, self.mgUri == want else { return }
            if let img = img { self.setImage(img) }
            if dur > 0, self.item?.autoDuration == true, (self.item?.br ?? "").isEmpty {
              self.autoBr = MGVideoThumbs.format(dur)
              self.applyBadges()
            }
          }
        }
      } else if let img = MVImageLoader.shared.cachedImage(src, maxPixel: cellPixels) {
        thumbView.image = img
      } else {
        thumbView.image = nil
        let want = src
        MVImageLoader.shared.load(src, maxPixel: cellPixels) { [weak self] img in
          guard let self = self, self.mgUri == want else { return }
          if let img = img {
            self.setImage(img)
          } else if it.isVideo, !it.videoUri.isEmpty {
            // pôster 404 → 1º quadro do vídeo
            MGVideoThumbs.shared.load(it.videoUri, maxPixel: cellPixels) { [weak self] vimg, _ in
              guard let self = self, self.mgUri == want, let vimg = vimg else { return }
              self.setImage(vimg)
            }
          }
        }
      }
    }
    if useVideoFrame, it.autoDuration, it.br.isEmpty, let d = MGVideoThumbs.shared.cachedDuration(it.videoUri), d > 0 {
      autoBr = MGVideoThumbs.format(d)
    }
    placeholderIcon.isHidden = thumbView.image != nil
    applyBadges()
  }

  private func setImage(_ img: UIImage) {
    let first = thumbView.image == nil
    thumbView.image = img
    placeholderIcon.isHidden = true
    if first && window != nil {
      thumbView.alpha = 0
      UIView.animate(withDuration: 0.14, delay: 0, options: [.allowUserInteraction]) { self.thumbView.alpha = 1 }
    }
  }

  func setSelection(on: Bool, selected: Bool) {
    selectionOn = on
    selectedOn = selected
    applyBadges()
  }

  private func applyBadges() {
    guard let it = item, !it.isCreate else { return }
    tlChip.isHidden = it.tl.isEmpty
    tlLabel.text = it.tl
    tlDotView.isHidden = !it.tlDot

    let trName: String?
    switch it.tr {
    case "video": trName = "video.fill"
    case "play": trName = "play.fill"
    case "multi": trName = "square.fill.on.square.fill"
    default: trName = nil
    }
    trBadge.isHidden = trName == nil || selectionOn
    if let n = trName { trIcon.image = UIImage(systemName: n, withConfiguration: UIImage.SymbolConfiguration(pointSize: 10.5, weight: .semibold)) }

    blLabel.text = it.bl
    blLabel.isHidden = it.bl.isEmpty
    blIcon.isHidden = it.bl.isEmpty || !it.blPlay

    let br = it.br.isEmpty ? autoBr : it.br
    brLabel.text = br
    brChip.isHidden = br.isEmpty

    gradientLayer.isHidden = it.bl.isEmpty && br.isEmpty

    checkView.isHidden = !selectionOn
    dimView.isHidden = !(selectionOn && selectedOn)
    let cfg = UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)
    if selectedOn {
      checkView.image = UIImage(systemName: "checkmark.circle.fill", withConfiguration: cfg)?
        .withRenderingMode(.alwaysOriginal).withTintColor(.systemBlue)
    } else {
      checkView.image = UIImage(systemName: "circle", withConfiguration: cfg)?
        .withRenderingMode(.alwaysOriginal).withTintColor(.white)
    }
    accessibilityTraits = selectionOn && selectedOn ? [.button, .selected] : .button
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let b = contentView.bounds
    thumbView.frame = b
    placeholderIcon.frame = b
    dimView.frame = b
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradientLayer.frame = CGRect(x: 0, y: b.height * 0.6, width: b.width, height: b.height * 0.4)
    CATransaction.commit()

    let m: CGFloat = 6
    if !tlChip.isHidden {
      let ls = tlLabel.sizeThatFits(CGSize(width: b.width - 2 * m, height: 20))
      let dotW: CGFloat = tlDotView.isHidden ? 0 : 10
      let w = min(b.width - 2 * m, ls.width + 12 + dotW)
      tlChip.frame = CGRect(x: m, y: m, width: w, height: 17)
      tlDotView.frame = CGRect(x: 6, y: 5.5, width: 6, height: 6)
      tlLabel.frame = CGRect(x: 6 + dotW, y: 0, width: w - 12 - dotW, height: 17)
    }
    trBadge.frame = CGRect(x: b.width - m - 22, y: m, width: 22, height: 22)
    trIcon.frame = trBadge.bounds
    checkView.frame = CGRect(x: b.width - 6 - 24, y: 6, width: 24, height: 24)

    var blx = m
    if !blIcon.isHidden {
      blIcon.frame = CGRect(x: blx, y: b.height - m - 15, width: 11, height: 15)
      blx += 13
    }
    if !blLabel.isHidden {
      let s = blLabel.sizeThatFits(CGSize(width: b.width / 2, height: 16))
      blLabel.frame = CGRect(x: blx, y: b.height - m - 15, width: min(s.width, b.width - blx - m), height: 15)
    }
    if !brChip.isHidden {
      let s = brLabel.sizeThatFits(CGSize(width: b.width / 2, height: 16))
      let w = s.width + 10
      brChip.frame = CGRect(x: b.width - m - w, y: b.height - m - 17, width: w, height: 17)
      brLabel.frame = CGRect(x: 5, y: 0, width: s.width, height: 17)
    }
    if !createIcon.isHidden {
      createIcon.frame = CGRect(x: 0, y: b.height / 2 - 26, width: b.width, height: 28)
      createLabelView.frame = CGRect(x: 4, y: b.height / 2 + 4, width: b.width - 8, height: 18)
    }
  }

  override var isHighlighted: Bool {
    didSet {
      let a: CGFloat = isHighlighted ? 0.82 : 1
      if contentView.alpha != a {
        UIView.animate(withDuration: isHighlighted ? 0.06 : 0.18, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
          self.contentView.alpha = a
        }
      }
    }
  }
}

final class MGSectionHeader: UICollectionReusableView {
  static let reuseId = "MGSectionHeader"
  let titleLabel = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    titleLabel.font = .systemFont(ofSize: 15, weight: .semibold)
    addSubview(titleLabel)
    accessibilityTraits = .header
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    titleLabel.frame = CGRect(x: 14, y: 0, width: bounds.width - 28, height: bounds.height)
  }
}

final class MGCollectionView: UICollectionView {
  var onLayout: (() -> Void)?
  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}

final class MGChildHost: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = false
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

// MARK: - Grade

public final class MGGridView: ExpoView, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  let onItemPress = EventDispatcher()
  let onItemLongPress = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onEndReached = EventDispatcher()
  let onScrollBegin = EventDispatcher()
  let onReady = EventDispatcher()

  private var collectionView: MGCollectionView!
  private let flow = UICollectionViewFlowLayout()

  private var mgSections: [MGSection] = []
  private var flatCount = 0
  private var itemsSig = ""
  private var rawItems: [MGItem] = []

  private var columnCount = 3
  private var gap: CGFloat = 1
  private var radius: CGFloat = 0
  private var useSections = false
  private var localeId = ""
  private var maxContentWidth: CGFloat = 0
  private var bottomInset: CGFloat = 0
  private var bgColor: UIColor = .systemBackground
  private var placeholderColor = UIColor(white: 0.56, alpha: 1)
  private var sectionTextColor: UIColor = .label
  private var createBg = UIColor(white: 0.98, alpha: 1)
  private var createFg = UIColor(white: 0.07, alpha: 1)

  private var selectionOn = false
  private var selectedKeys = Set<String>()
  private var selectedOrder: [String] = []

  private var rnChildren: [UIView] = []
  private let headerHost = MGChildHost()
  private let footerHost = MGChildHost()
  private var boundsObservers: [NSKeyValueObservation] = []
  private var headerH: CGFloat = 0
  private var footerH: CGFloat = 0
  private var didInitialOffset = false
  private var lastWidth: CGFloat = 0
  private var endReachedFor = -1
  private var readySent = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    flow.minimumLineSpacing = gap
    flow.minimumInteritemSpacing = gap
    flow.scrollDirection = .vertical
    let cv = MGCollectionView(frame: bounds, collectionViewLayout: flow)
    cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    cv.contentInsetAdjustmentBehavior = .never
    cv.alwaysBounceVertical = true
    cv.backgroundColor = bgColor
    cv.dataSource = self
    cv.delegate = self
    cv.register(MGCell.self, forCellWithReuseIdentifier: MGCell.reuseId)
    cv.register(MGSectionHeader.self, forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader,
                withReuseIdentifier: MGSectionHeader.reuseId)
    cv.addSubview(headerHost)
    cv.addSubview(footerHost)
    cv.onLayout = { [weak self] in self?.layoutHosts() }
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(onLongPressGesture(_:)))
    lp.minimumPressDuration = 0.4
    cv.addGestureRecognizer(lp)
    addSubview(cv)
    collectionView = cv
  }

  // MARK: props (idempotentes)

  func setItems(_ raw: [[String: Any]]?) {
    let parsed = (raw ?? []).compactMap { MGItem($0) }
    var sig = String(parsed.count)
    for it in parsed { sig += "\u{2}" + it.sig }
    if sig == itemsSig { return }
    itemsSig = sig
    rawItems = parsed
    rebuildSections()
  }

  func setColumns(_ v: Int?) {
    let c = max(1, min(8, v ?? 3))
    if c == columnCount { return }
    columnCount = c
    flow.invalidateLayout()
  }

  func setSpacing(_ v: Double?) {
    let g = CGFloat(max(0, v ?? 1))
    if g == gap { return }
    gap = g
    flow.minimumLineSpacing = g
    flow.minimumInteritemSpacing = g
    flow.invalidateLayout()
  }

  func setRadius(_ v: Double?) {
    let r = CGFloat(max(0, v ?? 0))
    if r == radius { return }
    radius = r
    collectionView.visibleCells.forEach { ($0 as? MGCell)?.cornerRadiusValue = r }
  }

  func setSections(_ v: Bool?) {
    let s = v ?? false
    if s == useSections { return }
    useSections = s
    rebuildSections()
  }

  func setLocale(_ v: String?) {
    let l = v ?? ""
    if l == localeId { return }
    localeId = l
    if useSections { rebuildSections() }
  }

  func setMaxContentWidth(_ v: Double?) {
    let m = CGFloat(max(0, v ?? 0))
    if m == maxContentWidth { return }
    maxContentWidth = m
    flow.invalidateLayout()
  }

  func setContentInsetBottom(_ v: Double?) {
    let b = CGFloat(max(0, v ?? 0))
    if b == bottomInset { return }
    bottomInset = b
    refreshInsets()
  }

  func setTheme(_ v: [String: Any]?) {
    let t = v ?? [:]
    var changed = false
    if let c = MGColor.parse(t["bg"]), c != bgColor { bgColor = c; changed = true }
    if let c = MGColor.parse(t["placeholder"]), c != placeholderColor { placeholderColor = c; changed = true }
    if let c = MGColor.parse(t["sectionText"]), c != sectionTextColor { sectionTextColor = c; changed = true }
    if let c = MGColor.parse(t["createBg"]), c != createBg { createBg = c; changed = true }
    if let c = MGColor.parse(t["createText"]), c != createFg { createFg = c; changed = true }
    if !changed { return }
    collectionView.backgroundColor = bgColor
    backgroundColor = bgColor
    collectionView.reloadData()
  }

  // MARK: seleção (dona = nativo; JS liga/desliga por função)

  func setSelectionMode(_ on: Bool) {
    if on == selectionOn && (on || selectedKeys.isEmpty) { return }
    selectionOn = on
    if !on { selectedKeys.removeAll(); selectedOrder.removeAll() }
    refreshVisibleSelection()
    emitSelection()
  }

  func clearSelection() {
    selectedKeys.removeAll()
    selectedOrder.removeAll()
    selectionOn = false
    refreshVisibleSelection()
    emitSelection()
  }

  func getSelection() -> [String] { selectedOrder }

  func scrollToTop(_ animated: Bool) {
    collectionView.setContentOffset(CGPoint(x: 0, y: -collectionView.contentInset.top), animated: animated)
  }

  private func toggle(_ key: String) {
    if selectedKeys.contains(key) {
      selectedKeys.remove(key)
      selectedOrder.removeAll { $0 == key }
    } else {
      selectedKeys.insert(key)
      selectedOrder.append(key)
    }
    UISelectionFeedbackGenerator().selectionChanged()
    refreshVisibleSelection()
    emitSelection()
  }

  private func refreshVisibleSelection() {
    for c in collectionView.visibleCells {
      guard let cell = c as? MGCell else { continue }
      cell.setSelection(on: selectionOn, selected: selectedKeys.contains(cell.mgKey))
    }
  }

  private func emitSelection() {
    onSelectionChange(["active": selectionOn, "keys": selectedOrder, "count": selectedOrder.count])
  }

  // MARK: dados

  private func rebuildSections() {
    var out: [MGSection] = []
    if useSections {
      let cal = Calendar.current
      let nowYear = cal.component(.year, from: Date())
      let fmtSame = DateFormatter()
      let fmtOther = DateFormatter()
      let loc = localeId.isEmpty ? Locale.current : Locale(identifier: localeId.replacingOccurrences(of: "_", with: "-"))
      fmtSame.locale = loc
      fmtOther.locale = loc
      fmtSame.setLocalizedDateFormatFromTemplate("LLLL")
      fmtOther.setLocalizedDateFormatFromTemplate("LLLL yyyy")
      var lastKey = Int.min
      for it in rawItems {
        var key = 0
        var title = ""
        if it.ts > 0 {
          let d = Date(timeIntervalSince1970: it.ts / 1000)
          let y = cal.component(.year, from: d)
          let m = cal.component(.month, from: d)
          key = y * 100 + m
          if key != lastKey {
            let raw = (y == nowYear ? fmtSame : fmtOther).string(from: d)
            title = raw.prefix(1).uppercased() + raw.dropFirst()
          }
        }
        if key != lastKey || out.isEmpty {
          out.append(MGSection(title: title, items: [it]))
          lastKey = key
        } else {
          out[out.count - 1].items.append(it)
        }
      }
    } else if !rawItems.isEmpty {
      out = [MGSection(title: "", items: rawItems)]
    }
    mgSections = out
    flatCount = rawItems.count
    let keys = Set(rawItems.map { $0.key })
    if !selectedKeys.isSubset(of: keys) {
      selectedKeys = selectedKeys.intersection(keys)
      selectedOrder = selectedOrder.filter { keys.contains($0) }
      emitSelection()
    }
    endReachedFor = -1
    collectionView.reloadData()
    if !readySent {
      readySent = true
      DispatchQueue.main.async { [weak self] in self?.onReady(["count": self?.flatCount ?? 0]) }
    }
  }

  private func item(at ip: IndexPath) -> MGItem? {
    guard ip.section < mgSections.count, ip.item < mgSections[ip.section].items.count else { return nil }
    return mgSections[ip.section].items[ip.item]
  }

  private func flatIndex(_ ip: IndexPath) -> Int {
    var n = 0
    for s in 0..<min(ip.section, mgSections.count) { n += mgSections[s].items.count }
    return n + ip.item
  }

  // MARK: geometria

  private func horizontalInset() -> CGFloat {
    let w = collectionView.bounds.width
    if maxContentWidth > 0 && w > maxContentWidth { return floor((w - maxContentWidth) / 2) }
    return 0
  }

  private func cellSide() -> CGFloat {
    let w = collectionView.bounds.width - horizontalInset() * 2
    let scale = window?.screen.scale ?? UIScreen.main.scale
    let raw = (w - gap * CGFloat(columnCount - 1)) / CGFloat(columnCount)
    return max(1, floor(raw * scale) / scale)
  }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                             sizeForItemAt indexPath: IndexPath) -> CGSize {
    let s = cellSide()
    return CGSize(width: s, height: s)
  }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                             insetForSectionAt section: Int) -> UIEdgeInsets {
    let h = horizontalInset()
    let last = section == mgSections.count - 1
    return UIEdgeInsets(top: 0, left: h, bottom: last ? 0 : gap, right: h)
  }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                             minimumLineSpacingForSectionAt section: Int) -> CGFloat { gap }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                             minimumInteritemSpacingForSectionAt section: Int) -> CGFloat { gap }

  public func collectionView(_ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
                             referenceSizeForHeaderInSection section: Int) -> CGSize {
    guard useSections, section < mgSections.count, !mgSections[section].title.isEmpty else { return .zero }
    return CGSize(width: collectionView.bounds.width, height: 38)
  }

  // MARK: data source

  public func numberOfSections(in collectionView: UICollectionView) -> Int { mgSections.count }

  public func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    section < mgSections.count ? mgSections[section].items.count : 0
  }

  public func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: MGCell.reuseId, for: indexPath)
    if let c = cell as? MGCell, let it = item(at: indexPath) {
      let scale = window?.screen.scale ?? UIScreen.main.scale
      c.cornerRadiusValue = radius
      c.configure(it, cellPixels: min(640, cellSide() * scale), placeholder: placeholderColor,
                  createBg: createBg, createFg: createFg,
                  selectionOn: selectionOn, selected: selectedKeys.contains(it.key))
    }
    return cell
  }

  public func collectionView(_ collectionView: UICollectionView, viewForSupplementaryElementOfKind kind: String,
                             at indexPath: IndexPath) -> UICollectionReusableView {
    let v = collectionView.dequeueReusableSupplementaryView(ofKind: kind, withReuseIdentifier: MGSectionHeader.reuseId, for: indexPath)
    if let h = v as? MGSectionHeader {
      h.titleLabel.text = indexPath.section < mgSections.count ? mgSections[indexPath.section].title : ""
      h.titleLabel.textColor = sectionTextColor
      h.backgroundColor = bgColor
    }
    return v
  }

  // MARK: delegate

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard let it = item(at: indexPath) else { return }
    if selectionOn && !it.isCreate {
      toggle(it.key)
      return
    }
    var body: [String: Any] = ["key": it.key, "index": flatIndex(indexPath), "create": it.isCreate]
    if let cell = collectionView.cellForItem(at: indexPath) {
      let r = cell.convert(cell.bounds, to: nil)
      body["x"] = r.origin.x
      body["y"] = r.origin.y
      body["width"] = r.width
      body["height"] = r.height
    }
    onItemPress(body)
  }

  @objc private func onLongPressGesture(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began else { return }
    let p = g.location(in: collectionView)
    guard let ip = collectionView.indexPathForItem(at: p), let it = item(at: ip), !it.isCreate else { return }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    onItemLongPress(["key": it.key, "index": flatIndex(ip), "selectionActive": selectionOn])
  }

  /// JS pediu seleção a partir de um toque longo: entra e já marca `key`.
  func beginSelection(with key: String?) {
    selectionOn = true
    if let k = key, !k.isEmpty, !selectedKeys.contains(k) {
      selectedKeys.insert(k)
      selectedOrder.append(k)
    }
    refreshVisibleSelection()
    emitSelection()
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    onScrollBegin([:])
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let h = scrollView.bounds.height
    guard h > 0, flatCount > 0 else { return }
    let rest = scrollView.contentSize.height + scrollView.contentInset.bottom - (scrollView.contentOffset.y + h)
    if rest < h * 0.8 && endReachedFor != flatCount {
      endReachedFor = flatCount
      onEndReached(["count": flatCount])
    }
  }

  // MARK: filhos RN (0 = cabeçalho, 1 = rodapé)

  public override func mountChildComponentView(_ childComponentView: UIView, index: Int) {
    let i = max(0, min(index, rnChildren.count))
    rnChildren.insert(childComponentView, at: i)
    reattachChildren()
  }

  public override func unmountChildComponentView(_ childComponentView: UIView, index: Int) {
    // O RN exige que o filho saia sem superview.
    childComponentView.removeFromSuperview()
    rnChildren.removeAll { $0 === childComponentView }
    reattachChildren()
  }

  private func reattachChildren() {
    boundsObservers.removeAll()
    for (i, v) in rnChildren.enumerated() {
      let host = i == 0 ? headerHost : footerHost
      if v.superview !== host { host.addSubview(v) }
      let obs = v.observe(\.bounds, options: [.new]) { [weak self] _, _ in
        DispatchQueue.main.async { self?.refreshInsets() }
      }
      boundsObservers.append(obs)
    }
    refreshInsets()
  }

  private func refreshInsets() {
    guard let cv = collectionView else { return }
    var hh: CGFloat = 0
    if let h = rnChildren.first { hh = h.frame.maxY }
    var fh: CGFloat = 0
    if rnChildren.count > 1 {
      for v in rnChildren[1...] { fh = max(fh, v.frame.maxY) }
    }
    let insets = UIEdgeInsets(top: hh, left: 0, bottom: fh + bottomInset, right: 0)
    if cv.contentInset != insets {
      let oldTop = cv.contentInset.top
      let atTop = cv.contentOffset.y <= -oldTop + 0.5
      cv.contentInset = insets
      cv.verticalScrollIndicatorInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomInset, right: 0)
      if !didInitialOffset || (atTop && !cv.isTracking && !cv.isDecelerating) {
        cv.contentOffset = CGPoint(x: 0, y: -hh)
        didInitialOffset = hh > 0
      }
    }
    headerH = hh
    footerH = fh
    layoutHosts()
  }

  private func layoutHosts() {
    guard let cv = collectionView else { return }
    let w = cv.bounds.width
    let hf = CGRect(x: 0, y: -headerH, width: w, height: headerH)
    if headerHost.frame != hf { headerHost.frame = hf }
    let ff = CGRect(x: 0, y: cv.contentSize.height, width: w, height: footerH)
    if footerHost.frame != ff { footerHost.frame = ff }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if collectionView.frame != bounds { collectionView.frame = bounds }
    if bounds.width != lastWidth {
      lastWidth = bounds.width
      flow.invalidateLayout()
    }
    layoutHosts()
  }
}
