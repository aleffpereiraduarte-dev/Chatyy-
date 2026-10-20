import UIKit
import Photos
import PhotosUI

// [2026-10-15 native-attach] Folha de anexos nativa (Telegram):
//   • sobe com spring; arrastar p/ cima expande p/ tela cheia, p/ baixo
//     recolhe/fecha (segue o dedo; flick decide); com a grade expandida o
//     scroll da grade só "solta" a folha quando está no topo;
//   • grade 3 colunas de fotos/vídeos recentes (PHCachingImageManager), 1º
//     quadrado = câmera AO VIVO (CAEngine; sem permissão = ícone);
//   • toque seleciona (número na ordem), toque longo = prévia/edição no JS;
//   • com seleção a barra de ações vira legenda + Enviar + chips HD /
//     "Como arquivo"; Enviar exporta os arquivos (iCloud incluído) e resolve;
//   • permissão: não pedida → cartão "Permitir acesso"; negada → "Abrir
//     Ajustes"; limitada → faixa com "Gerenciar" (presentLimitedLibraryPicker).
final class AttachSheetController: UIViewController,
  UICollectionViewDataSource, UICollectionViewDelegateFlowLayout, UICollectionViewDataSourcePrefetching,
  UIGestureRecognizerDelegate, PHPhotoLibraryChangeObserver, UITextFieldDelegate {

  var onFinish: (([String: Any]) -> Void)?
  /// [2026-10-19 attach-over-kb] folha numa janela acima do teclado (ChatyyAttachModule).
  var overKeyboardHost: AttachOverKeyboardHost?
  /// [2026-10-20 attach-inwindow] remoção sem dismiss (folha na janela do painel).
  var customRemove: ((@escaping () -> Void) -> Void)?
  var onCaptionEditing: ((Bool) -> Void)?

  private let config: AttachConfig
  private let imageManager = PHCachingImageManager()
  private var fetchResult: PHFetchResult<PHAsset>?
  private var selected: [String] = []
  private var selectedAssets: [String: PHAsset] = [:]
  private var observerRegistered = false
  private var finished = false
  private var exporting = false
  private var hd: Bool
  private var asFile = false
  private var cameraLive = false

  // geometria
  private var top: CGFloat = 0
  private var dismissOffset: CGFloat = 0
  private var didInitialLayout = false
  private var keyboardOverlap: CGFloat = 0
  private var panLastY: CGFloat = 0
  private var panTracking = false
  private var panInGrid = false

  // views
  private let dimView = UIView()
  private let sheetView = UIView()
  private let grabber = UIView()
  private let titleLabel = UILabel()
  private let closeButton = UIButton(type: .system)
  private let banner = UIView()
  private let bannerLabel = UILabel()
  private let bannerButton = UIButton(type: .system)
  private var bannerHeight: NSLayoutConstraint!
  private var permTop: NSLayoutConstraint!
  private let layout = UICollectionViewFlowLayout()
  private lazy var collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
  private let permView = UIView()
  private let permLabel = UILabel()
  private let permButton = UIButton(type: .system)
  private let bottomContainer = UIView()
  private var bottomInset: NSLayoutConstraint!
  private let hairline = UIView()
  private let actionsScroll = UIScrollView()
  private let actionsStack = UIStackView()
  private let selectionBar = UIView()
  private var hdChip: CAChip!
  private var fileChip: CAChip!
  private let captionField = UITextField()
  private let sendButton = UIButton(type: .custom)
  private let sendSpinner = UIActivityIndicatorView(style: .medium)
  private let countBadge = UILabel()

  private static let spacing: CGFloat = 2
  private static let headerH: CGFloat = 52
  private var hdrH: CGFloat { return config.galleryMode ? 66 : AttachSheetController.headerH } // [2026-10-20 attach-freeze]
  // [2026-10-20 attach-freeze] modo galeria
  private let segment = UISegmentedControl()
  private let hdButton = UIButton(type: .custom)
  private let albumsTable = UITableView(frame: .zero, style: .plain)
  private lazy var albumList = CAAlbumList(config: config)
  private var bottomHeight: NSLayoutConstraint!
  private static let barH: CGFloat = 96

  init(config: AttachConfig) {
    self.config = config
    self.hd = config.hdDefault
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    if observerRegistered { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    NotificationCenter.default.removeObserver(self)
  }

  override var preferredStatusBarStyle: UIStatusBarStyle { return config.dark ? .lightContent : .darkContent }

  // MARK: ciclo de vida

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    overrideUserInterfaceStyle = config.dark ? .dark : .light

    dimView.backgroundColor = UIColor(white: 0, alpha: 0.42)
    dimView.alpha = 0
    dimView.frame = view.bounds
    dimView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    dimView.isAccessibilityElement = true
    dimView.accessibilityLabel = config.t("close", "Fechar")
    dimView.accessibilityTraits = .button
    dimView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(onDimTap)))
    view.addSubview(dimView)

    sheetView.backgroundColor = config.bg
    sheetView.layer.cornerRadius = 14
    sheetView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    sheetView.clipsToBounds = true
    view.addSubview(sheetView)

    buildHeader()
    buildBanner()
    buildGrid()
    buildPermissionView()
    buildBottom()
    layoutContent()
    if config.galleryMode { buildAlbums() } // [2026-10-20 attach-freeze]

    let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
    pan.delegate = self
    sheetView.addGestureRecognizer(pan)

    NotificationCenter.default.addObserver(self, selector: #selector(onKeyboard(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(onKeyboard(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)

    refreshAuthorization()
    refreshSelectionUI(animated: false)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if !didInitialLayout && view.bounds.height > 0 {
      didInitialLayout = true
      top = collapsedTop
      dismissOffset = view.bounds.height - top
    }
    applyGeometry()
    let w = view.bounds.width
    let side = floor((w - AttachSheetController.spacing * 2) / 3)
    if layout.itemSize.width != side {
      layout.itemSize = CGSize(width: side, height: side)
      layout.invalidateLayout()
    }
    permTop.constant = config.allowCamera ? side + AttachSheetController.spacing : 0
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    view.layoutIfNeeded()
    caHaptic("select")
    UIView.animate(withDuration: 0.52, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0.2, options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.dismissOffset = 0
      self.dimView.alpha = 1
      self.applyGeometry()
    }
    cascadeActions()
    startCameraIfPossible()
  }

  // [2026-10-16 motion-attach] Galeria/Arquivo/Local/… sobem em cascata com
  // mola enquanto a folha sobe (Telegram). Reduzir Movimento / motion=false → estático.
  private var cascaded = false
  private func cascadeActions() {
    guard !cascaded else { return }
    cascaded = true
    guard config.motion, !UIAccessibility.isReduceMotionEnabled else { return }
    for (i, b) in actionsStack.arrangedSubviews.enumerated() {
      b.alpha = 0
      b.transform = CGAffineTransform(translationX: 0, y: 22).scaledBy(x: 0.82, y: 0.82)
      UIView.animate(withDuration: 0.55, delay: 0.08 + Double(min(i, 8)) * 0.035, usingSpringWithDamping: 0.7, initialSpringVelocity: 0.4,
                     options: [.allowUserInteraction, .beginFromCurrentState], animations: {
        b.alpha = 1
        b.transform = .identity
      }, completion: nil)
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    stopCamera()
  }

  // MARK: geometria

  private var expandedTop: CGFloat { return view.safeAreaInsets.top + 6 }

  private var collapsedTop: CGFloat {
    let h = view.bounds.height
    let side = floor((view.bounds.width - AttachSheetController.spacing * 2) / 3)
    // [2026-10-20 attach-freeze] galeria: topo logo abaixo do meio (WhatsApp).
    if config.galleryMode { return max(expandedTop, floor(h * 0.40)) }
    let want = AttachSheetController.headerH + side * 2.3 + AttachSheetController.barH + max(view.safeAreaInsets.bottom, 12)
    return max(expandedTop, h - want)
  }

  private var isExpanded: Bool { return top <= expandedTop + 1 }

  private func applyGeometry() {
    let w = view.bounds.width, h = view.bounds.height
    let hh = max(0, h - top)
    sheetView.bounds = CGRect(x: 0, y: 0, width: w, height: hh)
    sheetView.center = CGPoint(x: w / 2, y: top + hh / 2)
    sheetView.transform = CGAffineTransform(translationX: 0, y: dismissOffset)
    let range = max(1, collapsedTop - expandedTop)
    let p = 1 - min(1, max(0, (top - expandedTop) / range)) // 0 recolhida … 1 expandida
    closeButton.alpha = config.galleryMode ? 1 : p
    grabber.alpha = 1 - p * 0.6
    sheetView.layer.cornerRadius = 14 * (1 - p * 0.6)
    collectionView.isScrollEnabled = isExpanded
    if h > 0 {
      let travel = max(1, h - collapsedTop)
      dimView.alpha = max(0, 1 - dismissOffset / travel)
    }
  }

  // MARK: construção

  private func buildHeader() {
    grabber.backgroundColor = config.textSecondary.withAlphaComponent(0.35)
    grabber.layer.cornerRadius = 2.5
    grabber.translatesAutoresizingMaskIntoConstraints = false
    sheetView.addSubview(grabber)

    titleLabel.text = config.t("recents", "Recentes")
    titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
    titleLabel.textColor = config.text
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.accessibilityTraits = .header
    sheetView.addSubview(titleLabel)

    closeButton.setImage(CAFormat.symbol("xmark", 17, .semibold), for: .normal)
    closeButton.tintColor = config.text
    closeButton.accessibilityLabel = config.t("close", "Fechar")
    closeButton.addTarget(self, action: #selector(onCloseTap), for: .touchUpInside)
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    sheetView.addSubview(closeButton)
    guard config.galleryMode else { return }
    // [2026-10-20 attach-freeze] X (círculo) | Fotos/Álbuns | HD — P&B.
    titleLabel.isHidden = true
    closeButton.backgroundColor = config.chip
    closeButton.layer.cornerRadius = 22
    closeButton.setImage(CAFormat.symbol("xmark", 18, .medium), for: .normal)
    segment.insertSegment(withTitle: config.t("photos", "Fotos"), at: 0, animated: false)
    segment.insertSegment(withTitle: config.t("albums", "Álbuns"), at: 1, animated: false)
    segment.selectedSegmentIndex = 0
    segment.selectedSegmentTintColor = config.bg
    segment.backgroundColor = config.chip
    segment.setTitleTextAttributes([.foregroundColor: config.text, .font: UIFont.systemFont(ofSize: 15, weight: .semibold)], for: .selected)
    segment.setTitleTextAttributes([.foregroundColor: config.textSecondary, .font: UIFont.systemFont(ofSize: 15, weight: .regular)], for: .normal)
    segment.addTarget(self, action: #selector(onSegment), for: .valueChanged)
    segment.translatesAutoresizingMaskIntoConstraints = false
    sheetView.addSubview(segment)
    hdButton.setTitle("HD", for: .normal)
    hdButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .heavy)
    hdButton.layer.cornerRadius = 22
    hdButton.layer.borderWidth = 1.5
    hdButton.accessibilityLabel = "HD"
    hdButton.addTarget(self, action: #selector(onHdTap), for: .touchUpInside)
    hdButton.translatesAutoresizingMaskIntoConstraints = false
    sheetView.addSubview(hdButton)
    refreshHdButton()
  }

  private func refreshHdButton() {
    guard config.galleryMode else { return }
    hdButton.backgroundColor = hd ? config.text : config.chip
    hdButton.setTitleColor(hd ? config.bg : config.text, for: .normal)
    hdButton.layer.borderColor = (hd ? config.text : config.border).cgColor
    hdButton.accessibilityTraits = hd ? [.button, .selected] : .button
  }

  private func buildAlbums() {
    albumsTable.isHidden = true
    albumsTable.backgroundColor = config.bg
    albumsTable.separatorColor = config.border
    albumsTable.rowHeight = 72
    albumsTable.dataSource = albumList
    albumsTable.delegate = albumList
    albumsTable.register(UITableViewCell.self, forCellReuseIdentifier: "a")
    albumsTable.translatesAutoresizingMaskIntoConstraints = false
    albumList.onPick = { [weak self] coll, title in self?.pickAlbum(coll, title: title) }
    sheetView.addSubview(albumsTable)
    NSLayoutConstraint.activate([
      albumsTable.topAnchor.constraint(equalTo: collectionView.topAnchor),
      albumsTable.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
      albumsTable.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
      albumsTable.bottomAnchor.constraint(equalTo: sheetView.bottomAnchor),
    ])
  }

  @objc private func onSegment() {
    let showAlbums = segment.selectedSegmentIndex == 1
    caHaptic("select")
    if showAlbums {
      if albumList.isEmpty { albumList.load(); albumsTable.reloadData() }
      // álbuns pedem a folha alta
      if !isExpanded { animateTo(top: expandedTop, dismiss: 0, velocity: 0) }
    }
    albumsTable.isHidden = !showAlbums
  }

  private func pickAlbum(_ coll: PHAssetCollection?, title: String) {
    let opts = PHFetchOptions()
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    opts.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    if let c = coll {
      fetchResult = PHAsset.fetchAssets(in: c, options: opts)
    } else {
      loadAssets()
    }
    collectionView.reloadData()
    segment.setTitle(coll == nil ? config.t("photos", "Fotos") : title, forSegmentAt: 0)
    segment.selectedSegmentIndex = 0
    albumsTable.isHidden = true
    if (fetchResult?.count ?? 0) > 0 { collectionView.setContentOffset(.zero, animated: false) }
  }

  private func buildBanner() {
    banner.translatesAutoresizingMaskIntoConstraints = false
    banner.clipsToBounds = true
    banner.backgroundColor = config.surface
    sheetView.addSubview(banner)
    bannerLabel.text = config.t("limited", "Você permitiu acesso a algumas fotos.")
    bannerLabel.font = .systemFont(ofSize: 13)
    bannerLabel.textColor = config.textSecondary
    bannerLabel.numberOfLines = 2
    bannerLabel.translatesAutoresizingMaskIntoConstraints = false
    banner.addSubview(bannerLabel)
    bannerButton.setTitle(config.t("manage", "Gerenciar"), for: .normal)
    bannerButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
    bannerButton.setTitleColor(config.text, for: .normal)
    bannerButton.addTarget(self, action: #selector(onManageLimited), for: .touchUpInside)
    bannerButton.translatesAutoresizingMaskIntoConstraints = false
    bannerButton.setContentCompressionResistancePriority(.required, for: .horizontal)
    banner.addSubview(bannerButton)
    NSLayoutConstraint.activate([
      bannerLabel.leadingAnchor.constraint(equalTo: banner.leadingAnchor, constant: 16),
      bannerLabel.centerYAnchor.constraint(equalTo: banner.centerYAnchor),
      bannerLabel.trailingAnchor.constraint(lessThanOrEqualTo: bannerButton.leadingAnchor, constant: -8),
      bannerButton.trailingAnchor.constraint(equalTo: banner.trailingAnchor, constant: -12),
      bannerButton.centerYAnchor.constraint(equalTo: banner.centerYAnchor),
      bannerButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
  }

  private func buildGrid() {
    layout.minimumInteritemSpacing = AttachSheetController.spacing
    layout.minimumLineSpacing = AttachSheetController.spacing
    layout.scrollDirection = .vertical
    collectionView.backgroundColor = .clear
    collectionView.alwaysBounceVertical = true
    collectionView.showsVerticalScrollIndicator = false
    collectionView.contentInsetAdjustmentBehavior = .never
    collectionView.dataSource = self
    collectionView.delegate = self
    collectionView.prefetchDataSource = self
    collectionView.register(CAAssetCell.self, forCellWithReuseIdentifier: CAAssetCell.reuseId)
    collectionView.register(CACameraCell.self, forCellWithReuseIdentifier: CACameraCell.reuseId)
    collectionView.translatesAutoresizingMaskIntoConstraints = false
    collectionView.keyboardDismissMode = .interactive
    let lp = UILongPressGestureRecognizer(target: self, action: #selector(onLongPress(_:)))
    lp.minimumPressDuration = 0.4
    collectionView.addGestureRecognizer(lp)
    sheetView.addSubview(collectionView)
  }

  private func buildPermissionView() {
    permView.translatesAutoresizingMaskIntoConstraints = false
    permView.isHidden = true
    sheetView.addSubview(permView)
    let icon = UIImageView(image: CAFormat.symbol("photo.on.rectangle", 34, .light))
    icon.tintColor = config.textSecondary
    icon.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(icon)
    permLabel.font = .systemFont(ofSize: 15)
    permLabel.textColor = config.textSecondary
    permLabel.numberOfLines = 0
    permLabel.textAlignment = .center
    permLabel.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(permLabel)
    permButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
    permButton.setTitleColor(config.bg, for: .normal)
    permButton.backgroundColor = config.text
    permButton.layer.cornerRadius = 22
    permButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 22, bottom: 0, right: 22)
    permButton.addTarget(self, action: #selector(onPermButton), for: .touchUpInside)
    permButton.translatesAutoresizingMaskIntoConstraints = false
    permView.addSubview(permButton)
    NSLayoutConstraint.activate([
      icon.centerXAnchor.constraint(equalTo: permView.centerXAnchor),
      icon.bottomAnchor.constraint(equalTo: permLabel.topAnchor, constant: -12),
      permLabel.centerYAnchor.constraint(equalTo: permView.centerYAnchor, constant: -10),
      permLabel.leadingAnchor.constraint(equalTo: permView.leadingAnchor, constant: 32),
      permLabel.trailingAnchor.constraint(equalTo: permView.trailingAnchor, constant: -32),
      permButton.topAnchor.constraint(equalTo: permLabel.bottomAnchor, constant: 16),
      permButton.centerXAnchor.constraint(equalTo: permView.centerXAnchor),
      permButton.heightAnchor.constraint(equalToConstant: 44),
    ])
  }

  private func buildBottom() {
    bottomContainer.translatesAutoresizingMaskIntoConstraints = false
    bottomContainer.backgroundColor = config.bg
    sheetView.addSubview(bottomContainer)
    hairline.backgroundColor = config.border
    hairline.translatesAutoresizingMaskIntoConstraints = false
    bottomContainer.addSubview(hairline)

    // Ações (Galeria, Arquivo, Localização, …) — rolagem horizontal.
    actionsScroll.showsHorizontalScrollIndicator = false
    actionsScroll.alwaysBounceHorizontal = true
    actionsScroll.translatesAutoresizingMaskIntoConstraints = false
    bottomContainer.addSubview(actionsScroll)
    actionsStack.axis = .horizontal
    actionsStack.spacing = 2
    actionsStack.translatesAutoresizingMaskIntoConstraints = false
    actionsScroll.addSubview(actionsStack)
    let acts = config.actions.filter { !(config.allowCamera && $0.key == "camera") }
    for a in acts {
      let b = CAActionButton(key: a.key, title: a.label, config: config)
      b.translatesAutoresizingMaskIntoConstraints = false
      b.widthAnchor.constraint(equalToConstant: 72).isActive = true
      b.heightAnchor.constraint(equalToConstant: 78).isActive = true
      b.addTarget(self, action: #selector(onActionTap(_:)), for: .touchUpInside)
      actionsStack.addArrangedSubview(b)
    }
    NSLayoutConstraint.activate([
      actionsStack.leadingAnchor.constraint(equalTo: actionsScroll.contentLayoutGuide.leadingAnchor, constant: 8),
      actionsStack.trailingAnchor.constraint(equalTo: actionsScroll.contentLayoutGuide.trailingAnchor, constant: -8),
      actionsStack.topAnchor.constraint(equalTo: actionsScroll.contentLayoutGuide.topAnchor),
      actionsStack.bottomAnchor.constraint(equalTo: actionsScroll.contentLayoutGuide.bottomAnchor),
      actionsStack.heightAnchor.constraint(equalTo: actionsScroll.frameLayoutGuide.heightAnchor),
      actionsStack.widthAnchor.constraint(greaterThanOrEqualTo: actionsScroll.frameLayoutGuide.widthAnchor, constant: -16),
    ])
    if acts.count <= 5 { actionsStack.distribution = .equalSpacing }

    // Seleção: chips + legenda + enviar.
    selectionBar.translatesAutoresizingMaskIntoConstraints = false
    bottomContainer.addSubview(selectionBar)
    hdChip = CAChip(title: config.t("hd", "HD"), config: config)
    hdChip.on = hd
    hdChip.addTarget(self, action: #selector(onHdTap), for: .touchUpInside)
    fileChip = CAChip(title: config.t("asFile", "Enviar como arquivo"), config: config)
    fileChip.addTarget(self, action: #selector(onFileTap), for: .touchUpInside)
    let chips = UIStackView(arrangedSubviews: [hdChip, fileChip, UIView()])
    chips.axis = .horizontal
    chips.spacing = 8
    chips.alignment = .center
    chips.translatesAutoresizingMaskIntoConstraints = false
    selectionBar.addSubview(chips)

    captionField.placeholder = config.t("caption", "Adicionar legenda...")
    captionField.font = .systemFont(ofSize: 16)
    captionField.textColor = config.text
    captionField.tintColor = config.text
    captionField.backgroundColor = config.chip
    captionField.layer.cornerRadius = 20
    captionField.returnKeyType = .send
    captionField.delegate = self
    captionField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
    captionField.leftViewMode = .always
    captionField.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
    captionField.rightViewMode = .always
    captionField.attributedPlaceholder = NSAttributedString(
      string: config.t("caption", "Adicionar legenda..."),
      attributes: [.foregroundColor: config.textSecondary])
    captionField.translatesAutoresizingMaskIntoConstraints = false
    selectionBar.addSubview(captionField)

    sendButton.backgroundColor = config.text
    sendButton.layer.cornerRadius = 22
    sendButton.setImage(CAFormat.symbol("paperplane.fill", 18, .semibold), for: .normal)
    sendButton.tintColor = config.bg
    sendButton.accessibilityLabel = config.t("send", "Enviar")
    sendButton.addTarget(self, action: #selector(onSendTap), for: .touchUpInside)
    sendButton.translatesAutoresizingMaskIntoConstraints = false
    selectionBar.addSubview(sendButton)
    sendSpinner.color = config.bg
    sendSpinner.hidesWhenStopped = true
    sendSpinner.translatesAutoresizingMaskIntoConstraints = false
    sendButton.addSubview(sendSpinner)

    countBadge.font = .systemFont(ofSize: 12, weight: .bold)
    countBadge.textColor = config.text
    countBadge.backgroundColor = config.bg
    countBadge.textAlignment = .center
    countBadge.layer.cornerRadius = 10
    countBadge.layer.borderWidth = 1.5
    countBadge.layer.borderColor = config.text.cgColor
    countBadge.clipsToBounds = true
    countBadge.translatesAutoresizingMaskIntoConstraints = false
    selectionBar.addSubview(countBadge)

    NSLayoutConstraint.activate([
      chips.topAnchor.constraint(equalTo: selectionBar.topAnchor, constant: 8),
      chips.leadingAnchor.constraint(equalTo: selectionBar.leadingAnchor, constant: 12),
      chips.trailingAnchor.constraint(equalTo: selectionBar.trailingAnchor, constant: -12),
      chips.heightAnchor.constraint(equalToConstant: 30),
      captionField.leadingAnchor.constraint(equalTo: selectionBar.leadingAnchor, constant: 12),
      captionField.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -10),
      captionField.heightAnchor.constraint(equalToConstant: 40),
      captionField.bottomAnchor.constraint(equalTo: selectionBar.bottomAnchor, constant: -8),
      sendButton.trailingAnchor.constraint(equalTo: selectionBar.trailingAnchor, constant: -12),
      sendButton.centerYAnchor.constraint(equalTo: captionField.centerYAnchor),
      sendButton.widthAnchor.constraint(equalToConstant: 44),
      sendButton.heightAnchor.constraint(equalToConstant: 44),
      sendSpinner.centerXAnchor.constraint(equalTo: sendButton.centerXAnchor),
      sendSpinner.centerYAnchor.constraint(equalTo: sendButton.centerYAnchor),
      countBadge.topAnchor.constraint(equalTo: sendButton.topAnchor, constant: -6),
      countBadge.trailingAnchor.constraint(equalTo: sendButton.trailingAnchor, constant: 6),
      countBadge.heightAnchor.constraint(equalToConstant: 20),
      countBadge.widthAnchor.constraint(greaterThanOrEqualToConstant: 20),
    ])
  }

  private func layoutContent() {
    bannerHeight = banner.heightAnchor.constraint(equalToConstant: 0)
    // [2026-10-20 attach-freeze] galeria sem seleção = sem faixa de ações.
    bottomHeight = bottomContainer.heightAnchor.constraint(equalToConstant: config.galleryMode ? 0 : AttachSheetController.barH)
    if config.galleryMode {
      bottomContainer.clipsToBounds = true
      actionsScroll.isHidden = true
      NSLayoutConstraint.activate([
        segment.centerXAnchor.constraint(equalTo: sheetView.centerXAnchor),
        segment.centerYAnchor.constraint(equalTo: sheetView.topAnchor, constant: hdrH / 2 + 4),
        segment.heightAnchor.constraint(equalToConstant: 40),
        segment.widthAnchor.constraint(equalToConstant: 196),
        hdButton.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor, constant: -14),
        hdButton.centerYAnchor.constraint(equalTo: segment.centerYAnchor),
        hdButton.widthAnchor.constraint(equalToConstant: 44),
        hdButton.heightAnchor.constraint(equalToConstant: 44),
      ])
    }
    bottomInset = bottomContainer.bottomAnchor.constraint(equalTo: sheetView.bottomAnchor, constant: -12)
    bottomInset.priority = UILayoutPriority(999)
    // Sem permissão de fotos o cartão fica ABAIXO da 1ª linha (tile da câmera).
    permTop = permView.topAnchor.constraint(equalTo: collectionView.topAnchor)
    NSLayoutConstraint.activate([
      grabber.topAnchor.constraint(equalTo: sheetView.topAnchor, constant: 6),
      grabber.centerXAnchor.constraint(equalTo: sheetView.centerXAnchor),
      grabber.widthAnchor.constraint(equalToConstant: 36),
      grabber.heightAnchor.constraint(equalToConstant: 5),
      titleLabel.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor, constant: 16),
      titleLabel.centerYAnchor.constraint(equalTo: sheetView.topAnchor, constant: hdrH / 2 + 4),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -8),
      config.galleryMode
        ? closeButton.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor, constant: 14)
        : closeButton.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor, constant: -6),
      closeButton.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
      closeButton.widthAnchor.constraint(equalToConstant: 44),
      closeButton.heightAnchor.constraint(equalToConstant: 44),
      banner.topAnchor.constraint(equalTo: sheetView.topAnchor, constant: hdrH),
      banner.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
      banner.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
      bannerHeight,
      collectionView.topAnchor.constraint(equalTo: banner.bottomAnchor),
      collectionView.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
      collectionView.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
      collectionView.bottomAnchor.constraint(equalTo: bottomContainer.topAnchor),
      permTop,
      permView.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
      permView.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
      permView.bottomAnchor.constraint(equalTo: collectionView.bottomAnchor),
      bottomContainer.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
      bottomContainer.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
      bottomHeight,
      bottomInset,
      hairline.topAnchor.constraint(equalTo: bottomContainer.topAnchor),
      hairline.leadingAnchor.constraint(equalTo: bottomContainer.leadingAnchor),
      hairline.trailingAnchor.constraint(equalTo: bottomContainer.trailingAnchor),
      hairline.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
      actionsScroll.topAnchor.constraint(equalTo: bottomContainer.topAnchor, constant: 8),
      actionsScroll.leadingAnchor.constraint(equalTo: bottomContainer.leadingAnchor),
      actionsScroll.trailingAnchor.constraint(equalTo: bottomContainer.trailingAnchor),
      actionsScroll.heightAnchor.constraint(equalToConstant: 80),
      selectionBar.topAnchor.constraint(equalTo: bottomContainer.topAnchor),
      selectionBar.leadingAnchor.constraint(equalTo: bottomContainer.leadingAnchor),
      selectionBar.trailingAnchor.constraint(equalTo: bottomContainer.trailingAnchor),
      selectionBar.bottomAnchor.constraint(equalTo: bottomContainer.bottomAnchor),
    ])
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    updateBottomInset()
  }

  private func updateBottomInset() {
    let inset = max(view.safeAreaInsets.bottom, 12, keyboardOverlap + 4)
    bottomInset.constant = -inset
  }

  // MARK: permissão / dados

  private var authStatus: PHAuthorizationStatus { return PHPhotoLibrary.authorizationStatus(for: .readWrite) }

  private func refreshAuthorization() {
    let st = authStatus
    switch st {
    case .authorized, .limited:
      permView.isHidden = true
      collectionView.isHidden = false
      if !observerRegistered {
        PHPhotoLibrary.shared().register(self)
        observerRegistered = true
      }
      loadAssets()
    case .notDetermined:
      showPermission(text: config.t("permPrompt", "Permita o acesso às fotos para enviar as mais recentes com um toque."),
                     button: config.t("permAllow", "Permitir acesso"))
    default:
      showPermission(text: config.t("permDenied", "O acesso às fotos está desativado. Ative nos Ajustes para ver suas fotos aqui."),
                     button: config.t("permSettings", "Abrir Ajustes"))
    }
    let limited = st == .limited
    bannerHeight.constant = limited ? 44 : 0
    banner.isHidden = !limited
  }

  private func showPermission(text: String, button: String) {
    permLabel.text = text
    permButton.setTitle(button, for: .normal)
    permView.isHidden = false
    // Sem fotos, a grade ainda mostra o tile da câmera (topo).
    collectionView.isHidden = !config.allowCamera
    fetchResult = nil
    collectionView.reloadData()
  }

  private func loadAssets() {
    let opts = PHFetchOptions()
    opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    opts.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    opts.includeAssetSourceTypes = [.typeUserLibrary, .typeCloudShared, .typeiTunesSynced]
    fetchResult = PHAsset.fetchAssets(with: opts)
    collectionView.reloadData()
  }

  func photoLibraryDidChange(_ changeInstance: PHChange) {
    DispatchQueue.main.async {
      guard !self.finished else { return }
      if let fr = self.fetchResult, let det = changeInstance.changeDetails(for: fr) {
        self.fetchResult = det.fetchResultAfterChanges
        self.collectionView.reloadData()
      } else if self.fetchResult == nil {
        self.refreshAuthorization()
      }
      // Itens selecionados que deixaram de ser acessíveis (acesso limitado).
      let ids = self.selected
      if !ids.isEmpty {
        let still = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        var ok = Set<String>()
        still.enumerateObjects { a, _, _ in ok.insert(a.localIdentifier) }
        if ok.count != ids.count {
          self.selected = ids.filter { ok.contains($0) }
          self.refreshSelectionUI(animated: true)
          self.refreshVisibleBadges(animated: false)
        }
      }
    }
  }

  @objc private func onPermButton() {
    switch authStatus {
    case .notDetermined:
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
        DispatchQueue.main.async { self.refreshAuthorization() }
      }
    default:
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
  }

  @objc private func onManageLimited() {
    PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: self)
  }

  // MARK: câmera ao vivo

  private func startCameraIfPossible() {
    guard config.allowCamera, CAEngine.authorized, !cameraLive else { return }
    cameraLive = true
    CAEngine.shared.acquire { [weak self] in
      guard let self = self, self.cameraLive else { return }
      if let cell = self.collectionView.cellForItem(at: IndexPath(item: 0, section: 0)) as? CACameraCell { cell.startLive() }
    }
  }

  private func stopCamera() {
    guard cameraLive else { return }
    cameraLive = false
    if let cell = collectionView.cellForItem(at: IndexPath(item: 0, section: 0)) as? CACameraCell { cell.stopLive() }
    CAEngine.shared.relinquish()
  }

  // MARK: collection

  private var cameraOffset: Int { return config.allowCamera ? 1 : 0 }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    return cameraOffset + (fetchResult?.count ?? 0)
  }

  private func asset(at ip: IndexPath) -> PHAsset? {
    let i = ip.item - cameraOffset
    guard let fr = fetchResult, i >= 0, i < fr.count else { return nil }
    return fr.object(at: i)
  }

  private var thumbSize: CGSize {
    let s = layout.itemSize.width * UIScreen.main.scale
    return CGSize(width: s, height: s)
  }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    if config.allowCamera && indexPath.item == 0 {
      let cell = collectionView.dequeueReusableCell(withReuseIdentifier: CACameraCell.reuseId, for: indexPath) as! CACameraCell
      cell.accessibilityLabel = config.t("camera", "Câmera")
      if cameraLive { cell.startLive() }
      return cell
    }
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: CAAssetCell.reuseId, for: indexPath) as! CAAssetCell
    cell.badge.setTheme(fill: config.text, ink: config.bg)
    guard let a = asset(at: indexPath) else { return cell }
    let isVideo = a.mediaType == .video
    cell.assetId = a.localIdentifier
    cell.configure(video: isVideo, duration: a.duration)
    if let idx = selected.firstIndex(of: a.localIdentifier) {
      cell.setSelected(number: idx + 1, animated: false)
    } else {
      cell.setSelected(number: nil, animated: false)
    }
    cell.accessibilityLabel = isVideo
      ? "\(config.t("video", "Vídeo")) \(CAFormat.duration(a.duration))"
      : config.t("photo", "Foto")
    if cell.requestId != PHInvalidImageRequestID { imageManager.cancelImageRequest(cell.requestId) }
    let opts = PHImageRequestOptions()
    opts.deliveryMode = .opportunistic
    opts.resizeMode = .fast
    opts.isNetworkAccessAllowed = true
    let id = a.localIdentifier
    cell.requestId = imageManager.requestImage(for: a, targetSize: thumbSize, contentMode: .aspectFill, options: opts) { [weak cell] img, _ in
      guard let cell = cell, cell.assetId == id else { return }
      cell.imageView.image = img
    }
    return cell
  }

  func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    if let c = cell as? CACameraCell { c.stopLive() }
  }

  func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    if let c = cell as? CACameraCell, cameraLive { c.startLive() }
  }

  func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
    let assets = indexPaths.compactMap { asset(at: $0) }
    if !assets.isEmpty { imageManager.startCachingImages(for: assets, targetSize: thumbSize, contentMode: .aspectFill, options: nil) }
  }

  func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
    let assets = indexPaths.compactMap { asset(at: $0) }
    if !assets.isEmpty { imageManager.stopCachingImages(for: assets, targetSize: thumbSize, contentMode: .aspectFill, options: nil) }
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    if exporting { return }
    if config.allowCamera && indexPath.item == 0 {
      caHaptic("light")
      finish(["action": "action", "key": "camera"])
      return
    }
    guard let a = asset(at: indexPath) else { return }
    toggle(a)
  }

  private func toggle(_ a: PHAsset) {
    let id = a.localIdentifier
    if let i = selected.firstIndex(of: id) {
      selected.remove(at: i)
      selectedAssets[id] = nil
    } else {
      if selected.count >= config.maxSelect {
        caHaptic("warn")
        return
      }
      selected.append(id)
      selectedAssets[id] = a
    }
    caHaptic("select")
    refreshVisibleBadges(animated: true, changed: id)
    refreshSelectionUI(animated: true)
  }

  private func refreshVisibleBadges(animated: Bool, changed: String? = nil) {
    for cell in collectionView.visibleCells {
      guard let c = cell as? CAAssetCell else { continue }
      let n = selected.firstIndex(of: c.assetId).map { $0 + 1 }
      c.setSelected(number: n, animated: animated && c.assetId == changed)
    }
  }

  @objc private func onLongPress(_ g: UILongPressGestureRecognizer) {
    guard g.state == .began, !exporting else { return }
    let p = g.location(in: collectionView)
    guard let ip = collectionView.indexPathForItem(at: p), let a = asset(at: ip) else { return }
    caHaptic("heavy")
    var list: [PHAsset] = selected.compactMap { selectedAssets[$0] }
    if !list.contains(where: { $0.localIdentifier == a.localIdentifier }) {
      if list.count < config.maxSelect { list.append(a) } else { list = [a] }
    }
    exportAndFinish(list, action: "preview")
  }

  // MARK: seleção / barra inferior

  private func refreshSelectionUI(animated: Bool) {
    let n = selected.count
    let showSel = n > 0
    titleLabel.text = showSel
      ? config.t("selectedCount", "{count} selecionados").replacingOccurrences(of: "{count}", with: "\(n)")
      : config.t("recents", "Recentes")
    countBadge.text = "\(n)"
    countBadge.isHidden = n < 2
    hdChip.isHidden = asFile
    if config.galleryMode { bottomHeight.constant = showSel ? AttachSheetController.barH : 0 } // [2026-10-20 attach-freeze]
    let changes = {
      if self.config.galleryMode { self.view.layoutIfNeeded() }
      self.actionsScroll.alpha = showSel ? 0 : 1
      self.actionsScroll.transform = showSel ? CGAffineTransform(translationX: 0, y: 14) : .identity
      self.selectionBar.alpha = showSel ? 1 : 0
      self.selectionBar.transform = showSel ? .identity : CGAffineTransform(translationX: 0, y: 14)
    }
    actionsScroll.isUserInteractionEnabled = !showSel
    selectionBar.isUserInteractionEnabled = showSel
    if animated {
      UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0.2, options: [.allowUserInteraction, .beginFromCurrentState], animations: changes)
    } else {
      changes()
    }
    if !showSel && captionField.isFirstResponder { captionField.resignFirstResponder() }
  }

  @objc private func onHdTap() {
    hd.toggle()
    hdChip.on = hd
    refreshHdButton() // [2026-10-20 attach-freeze]
    caHaptic("select")
  }

  @objc private func onFileTap() {
    asFile.toggle()
    fileChip.on = asFile
    hdChip.isHidden = asFile
    caHaptic("select")
  }

  // [2026-10-19 attach-over-kb] acima do teclado a legenda não teria teclado
  // visível: a janela desce p/ baixo do teclado e vira key antes do foco; se o
  // teclado do composer já estava aberto (mesmo quadro, pode não vir
  // notificação nova) a folha se ajusta pelo último quadro conhecido.
  func textFieldDidEndEditing(_ textField: UITextField) {
    onCaptionEditing?(false) // [2026-10-20 attach-inwindow]
  }

  func textFieldShouldBeginEditing(_ textField: UITextField) -> Bool {
    onCaptionEditing?(true) // [2026-10-20 attach-inwindow]
    if let host = overKeyboardHost {
      host.prepareForTextInput()
      let kt = AttachKeyboardTracker.shared
      if kt.visible { applyKeyboard(end: kt.endFrame, hide: false, duration: 0.25) }
    }
    return true
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    onSendTap()
    return false
  }

  @objc private func onSendTap() {
    guard !exporting, !selected.isEmpty else { return }
    caHaptic("light")
    let list = selected.compactMap { selectedAssets[$0] }
    exportAndFinish(list, action: "send")
  }

  private func setExporting(_ on: Bool) {
    exporting = on
    sendButton.isEnabled = !on
    sendButton.setImage(on ? nil : CAFormat.symbol("paperplane.fill", 18, .semibold), for: .normal)
    if on { sendSpinner.startAnimating() } else { sendSpinner.stopAnimating() }
    collectionView.isUserInteractionEnabled = !on
    hdChip.isEnabled = !on
    fileChip.isEnabled = !on
    captionField.isEnabled = !on
  }

  private func exportAndFinish(_ assets: [PHAsset], action: String) {
    guard !assets.isEmpty else { return }
    setExporting(true)
    let caption = (captionField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let wantFile = action == "send" && asFile
    AttachExporter.export(assets, asFile: wantFile) { [weak self] items in
      guard let self = self, !self.finished else { return }
      self.setExporting(false)
      var r: [String: Any] = ["action": action, "items": items]
      if action == "send" {
        r["caption"] = caption
        r["hd"] = self.hd
        r["asFile"] = self.asFile
      }
      self.finish(r)
    }
  }

  // MARK: ações

  @objc private func onActionTap(_ b: CAActionButton) {
    guard !exporting else { return }
    finish(["action": "action", "key": b.key])
  }

  @objc private func onDimTap() {
    if captionField.isFirstResponder { captionField.resignFirstResponder(); return }
    finish(["action": "cancel"])
  }

  @objc private func onCloseTap() {
    finish(["action": "cancel"])
  }

  // MARK: arrastar

  func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    return other === collectionView.panGestureRecognizer
  }

  func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
    guard let pan = g as? UIPanGestureRecognizer else { return true }
    let v = pan.velocity(in: view)
    // Gestos horizontais ficam com a barra de ações.
    if abs(v.x) > abs(v.y) { return false }
    return !exporting
  }

  @objc private func onPan(_ g: UIPanGestureRecognizer) {
    let y = g.translation(in: view).y
    switch g.state {
    case .began:
      panLastY = y
      panInGrid = collectionView.frame.contains(g.location(in: sheetView))
      panTracking = !(isExpanded && panInGrid && collectionView.contentOffset.y > 0)
      if captionField.isFirstResponder { captionField.resignFirstResponder() }
    case .changed:
      let d = y - panLastY
      panLastY = y
      if isExpanded && panInGrid && !panTracking {
        // A grade rola; só "pega" a folha quando chega ao topo puxando p/ baixo.
        if collectionView.contentOffset.y <= 0 && d > 0 { panTracking = true } else { return }
      }
      if panInGrid { collectionView.contentOffset = .zero }
      applyDrag(d)
    case .ended, .cancelled, .failed:
      guard panTracking else { return }
      panTracking = false
      settle(velocity: g.velocity(in: view).y)
    default:
      break
    }
  }

  private func applyDrag(_ d: CGFloat) {
    var d = d
    if d > 0 {
      // Para baixo: primeiro recolhe, depois arrasta para fechar.
      let room = collapsedTop - top
      if room > 0 {
        let use = min(room, d)
        top += use
        d -= use
      }
      if d > 0 { dismissOffset += d }
    } else if d < 0 {
      // Para cima: primeiro desfaz o arrasto de fechar, depois expande.
      if dismissOffset > 0 {
        let use = min(dismissOffset, -d)
        dismissOffset -= use
        d += use
      }
      if d < 0 { top = max(expandedTop, top + d) }
    }
    applyGeometry()
  }

  private func settle(velocity v: CGFloat) {
    if dismissOffset > 0 {
      if dismissOffset > 110 || v > 900 {
        finish(["action": "cancel"], velocity: v) // [2026-10-19 attach-close] segue o dedo
        return
      }
      animateTo(top: top, dismiss: 0, velocity: v)
      return
    }
    let mid = (expandedTop + collapsedTop) / 2
    var target: CGFloat
    if v < -500 { target = expandedTop }
    else if v > 500 { target = collapsedTop }
    else { target = top < mid ? expandedTop : collapsedTop }
    if v > 1600 && top >= collapsedTop - 1 {
      finish(["action": "cancel"], velocity: v) // [2026-10-19 attach-close]
      return
    }
    animateTo(top: target, dismiss: 0, velocity: v)
  }

  private func animateTo(top t: CGFloat, dismiss: CGFloat, velocity: CGFloat) {
    let dist = max(1, abs(t - top) + abs(dismiss - dismissOffset))
    let iv = min(8, abs(velocity) / dist)
    UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.88, initialSpringVelocity: iv, options: [.allowUserInteraction, .beginFromCurrentState]) {
      self.top = t
      self.dismissOffset = dismiss
      self.applyGeometry()
      self.view.layoutIfNeeded()
    }
  }

  // MARK: teclado

  @objc private func onKeyboard(_ n: Notification) {
    // [2026-10-19 attach-instant] fechando: o teclado que sobe agora é o do
    // composer (foco devolvido no nativo) — a folha não pode expandir/subir.
    guard !finished else { return }
    guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
    let dur = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
    // [2026-10-19 attach-over-kb] acima do teclado: o teclado do composer
    // (aberto por baixo da folha) não conta — só o da legenda.
    if overKeyboardHost != nil && !captionField.isFirstResponder && n.name != UIResponder.keyboardWillHideNotification { return }
    applyKeyboard(end: end, hide: n.name == UIResponder.keyboardWillHideNotification, duration: dur)
  }

  private func applyKeyboard(end: CGRect, hide: Bool, duration dur: Double) {
    guard !finished else { return }
    let local = view.convert(end, from: nil)
    let overlap = hide ? 0 : max(0, view.bounds.maxY - local.minY)
    keyboardOverlap = overlap
    updateBottomInset()
    // Teclado aberto na folha recolhida espremeria a grade a zero → expande.
    let expand = overlap > 0 && !isExpanded
    UIView.animate(withDuration: dur, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
      if expand {
        self.top = self.expandedTop
        self.applyGeometry()
      }
      self.view.layoutIfNeeded()
    }
  }

  // MARK: fim

  // [2026-10-19 attach-instant] Avisos p/ o composer nativo (expo-chat-composer)
  // devolver o teclado sem passar pelo JS: WillClose no início da descida,
  // DidClose no fim do dismiss (antes de resolver a promessa).
  // userInfo: action (String), user (Bool: false = fechada pelo JS/substituída).
  static let willCloseNote = Notification.Name("ChatyyAttachSheetWillClose")
  static let didCloseNote = Notification.Name("ChatyyAttachSheetDidClose")
  // [2026-10-19 attach-over-kb] logo antes de a folha entrar; userInfo
  // overKeyboard (Bool): true = teclado do composer fica aberto por baixo.
  static let willPresentNote = Notification.Name("ChatyyAttachSheetWillPresent")

  private func postClose(_ name: Notification.Name, _ result: [String: Any], byUser: Bool) {
    let action: String = (result["action"] as? String) ?? ""
    let info: [AnyHashable: Any] = ["action": action, "user": byUser]
    NotificationCenter.default.post(name: name, object: nil, userInfo: info)
  }

  // [2026-10-19 attach-close] Founder: "na hora de baixar a folha ainda dá
  // uma travadinha". RAIZ: (1) soltar o dedo no arrasto chamava uma descida
  // .curveEaseIn de 0,24 s — começa PARADA (velocidade 0) e acelera: a folha
  // que vinha a 1000+ pt/s freava no quadro da soltura e só depois caía =
  // engasgo; (2) stopCamera() no mesmo quadro: previewLayer.session = nil
  // sincroniza com a fila da AVCaptureSession NO MAIN → quadros perdidos bem
  // no início da descida. AGORA: arrasto → mola criticamente amortecida que
  // COMEÇA na velocidade do dedo (sem freada); toque fora/X → curva ease-out
  // (sai rápido, assenta fora da tela); câmera solta só depois de a folha
  // sair da tela. motion=false (__chatyy_motion_attach=false) = curva antiga.
  private func finish(_ result: [String: Any], byUser: Bool = true, velocity: CGFloat = 0) {
    guard !finished else { return }
    finished = true
    if captionField.isFirstResponder { captionField.resignFirstResponder() }
    if !config.motion { stopCamera() }
    postClose(AttachSheetController.willCloseNote, result, byUser: byUser)
    let h = view.bounds.height
    let target = max(h - self.top, 1)
    let changes = {
      self.dismissOffset = target
      self.applyGeometry()
      self.dimView.alpha = 0
    }
    let done: (Bool) -> Void = { _ in
      self.stopCamera()
      self.removeFromScreen {
        self.postClose(AttachSheetController.didCloseNote, result, byUser: byUser)
        self.onFinish?(result)
        self.onFinish = nil
      }
    }
    let remaining = max(1, target - dismissOffset)
    let v = max(0, velocity)
    if !config.motion {
      UIView.animate(withDuration: 0.24, delay: 0, options: [.curveEaseIn, .beginFromCurrentState], animations: changes, completion: done)
    } else if v > 60 {
      // Desaceleração linear a partir de v cobriria `remaining` em 2·d/v.
      let dur = min(0.34, max(0.16, Double(2 * remaining / v)))
      UIView.animate(withDuration: dur, delay: 0, usingSpringWithDamping: 1.0, initialSpringVelocity: v / remaining,
                     options: [.beginFromCurrentState, .allowUserInteraction], animations: changes, completion: done)
    } else {
      UIView.animate(withDuration: 0.26, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: changes, completion: done)
    }
  }

  func closeFromJS() {
    finish(["action": "cancel"], byUser: false)
  }

  /// Substituída por outra folha: some sem animação e resolve 'cancel'.
  func finishSilently() {
    guard !finished else { return }
    finished = true
    stopCamera()
    let cb = onFinish
    onFinish = nil
    let result: [String: Any] = ["action": "cancel"]
    postClose(AttachSheetController.willCloseNote, result, byUser: false)
    removeFromScreen {
      self.postClose(AttachSheetController.didCloseNote, result, byUser: false)
      cb?(result)
    }
  }

  /// Modal: dismiss do UIKit. Acima do teclado: a janela some (attach-over-kb).
  private func removeFromScreen(_ completion: @escaping () -> Void) {
    if let host = overKeyboardHost {
      overKeyboardHost = nil
      host.tearDown(completion)
      return
    }
    if let rm = customRemove { // [2026-10-20 attach-inwindow]
      customRemove = nil
      onCaptionEditing = nil
      rm(completion)
      return
    }
    dismiss(animated: false, completion: completion)
  }
}


// MARK: - Álbuns (attach-freeze, modo galeria)

/// Lista de álbuns (Recentes + favoritos/vídeos/selfies/capturas + álbuns do usuário).
final class CAAlbumList: NSObject, UITableViewDataSource, UITableViewDelegate {
  var onPick: ((PHAssetCollection?, String) -> Void)?
  private let config: AttachConfig
  private var rows: [(coll: PHAssetCollection?, title: String, count: Int, cover: PHAsset?)] = []
  private let imageManager = PHCachingImageManager()
  var isEmpty: Bool { return rows.isEmpty }

  init(config: AttachConfig) {
    self.config = config
    super.init()
  }

  private static func mediaOpts() -> PHFetchOptions {
    let o = PHFetchOptions()
    o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    o.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    return o
  }

  func load() {
    var out: [(coll: PHAssetCollection?, title: String, count: Int, cover: PHAsset?)] = []
    let all = PHAsset.fetchAssets(with: CAAlbumList.mediaOpts())
    out.append((nil, config.t("allPhotos", "Recentes"), all.count, all.firstObject))
    let smart: [PHAssetCollectionSubtype] = [.smartAlbumFavorites, .smartAlbumVideos, .smartAlbumSelfPortraits, .smartAlbumScreenshots, .smartAlbumLivePhotos]
    for st in smart {
      let r = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: st, options: nil)
      r.enumerateObjects { c, _, _ in
        let a = PHAsset.fetchAssets(in: c, options: CAAlbumList.mediaOpts())
        if a.count > 0 { out.append((c, c.localizedTitle ?? "", a.count, a.firstObject)) }
      }
    }
    let user = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
    user.enumerateObjects { c, _, _ in
      let a = PHAsset.fetchAssets(in: c, options: CAAlbumList.mediaOpts())
      if a.count > 0 { out.append((c, c.localizedTitle ?? "", a.count, a.firstObject)) }
    }
    rows = out
  }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return rows.count }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "a", for: indexPath)
    let row = rows[indexPath.row]
    var c = cell.defaultContentConfiguration()
    c.text = row.title
    c.secondaryText = "\(row.count)"
    c.textProperties.color = config.text
    c.secondaryTextProperties.color = config.textSecondary
    c.imageProperties.maximumSize = CGSize(width: 56, height: 56)
    c.imageProperties.reservedLayoutSize = CGSize(width: 56, height: 56)
    c.imageProperties.cornerRadius = 6
    c.image = UIImage(systemName: "photo")
    cell.contentConfiguration = c
    cell.backgroundColor = config.bg
    cell.accessoryType = .disclosureIndicator
    cell.tag = indexPath.row
    if let cover = row.cover {
      let s = 56 * UIScreen.main.scale
      let o = PHImageRequestOptions()
      o.deliveryMode = .opportunistic
      o.isNetworkAccessAllowed = true
      let tagNow = indexPath.row
      imageManager.requestImage(for: cover, targetSize: CGSize(width: s, height: s), contentMode: .aspectFill, options: o) { [weak cell] img, _ in
        guard let cell = cell, cell.tag == tagNow, let img = img, var cc = cell.contentConfiguration as? UIListContentConfiguration else { return }
        cc.image = img
        cell.contentConfiguration = cc
      }
    }
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    let row = rows[indexPath.row]
    caHaptic("select")
    onPick?(row.coll, row.title)
  }
}
