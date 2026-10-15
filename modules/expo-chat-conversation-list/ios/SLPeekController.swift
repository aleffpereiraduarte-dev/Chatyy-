import ImageIO
import UIKit

// [2026-10-15 native-lists] Prévia do toque longo na aba STATUS (iOS):
// a última atualização do contato (foto / pôster do vídeo, ou o status de
// texto na cor dele) com nome e hora — sem marcar como visto.
final class SLPeekController: UIViewController {
  private let row: SLRow
  private let palette: SLPalette
  private let imageView = UIImageView()
  private let textLabel = UILabel()
  private let nameLabel = UILabel()
  private let timeLabel = UILabel()
  private let shade = CAGradientLayer()
  private var task: URLSessionDataTask?
  private let authToken: String

  init(row: SLRow, palette: SLPalette, authToken: String) {
    self.row = row
    self.palette = palette
    self.authToken = authToken
    super.init(nibName: nil, bundle: nil)
    let w = min(UIScreen.main.bounds.width * 0.72, 320)
    preferredContentSize = CGSize(width: w, height: (w * 16 / 9).rounded())
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit { task?.cancel() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = SLColor.parse(row.thumbBg) ?? UIColor(clHex: 0x1A1A1A)
    view.clipsToBounds = true

    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    view.addSubview(imageView)

    textLabel.numberOfLines = 0
    textLabel.textAlignment = .center
    textLabel.textColor = .white
    textLabel.adjustsFontSizeToFitWidth = true
    textLabel.minimumScaleFactor = 0.5
    textLabel.font = SLColor.thumbFont(row.thumbFont, size: 26)
    textLabel.text = row.thumbText
    textLabel.isHidden = row.thumbText.isEmpty
    view.addSubview(textLabel)

    shade.colors = [UIColor(white: 0, alpha: 0.55).cgColor, UIColor(white: 0, alpha: 0).cgColor]
    shade.startPoint = CGPoint(x: 0.5, y: 0)
    shade.endPoint = CGPoint(x: 0.5, y: 1)
    view.layer.addSublayer(shade)

    nameLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    nameLabel.textColor = .white
    nameLabel.text = row.title
    view.addSubview(nameLabel)
    timeLabel.font = UIFont.systemFont(ofSize: 12)
    timeLabel.textColor = UIColor(white: 1, alpha: 0.75)
    timeLabel.text = row.time
    view.addSubview(timeLabel)

    if row.peekURL.isEmpty {
      if row.thumbText.isEmpty {
        // Sem mídia nem texto: avatar grande do contato.
        if let img = CLImageLoader.shared.cachedImage(row.tileURL) {
          imageView.image = img
        } else if !row.tileURL.isEmpty {
          CLImageLoader.shared.load(row.tileURL, auth: row.tileAuth) { [weak self] img in
            self?.imageView.image = img
          }
        }
      }
    } else {
      loadPeek(row.peekURL)
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let b = view.bounds
    imageView.frame = b
    textLabel.frame = b.insetBy(dx: 22, dy: 60)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shade.frame = CGRect(x: 0, y: 0, width: b.width, height: 84)
    CATransaction.commit()
    nameLabel.frame = CGRect(x: 14, y: 12, width: b.width - 28, height: 20)
    timeLabel.frame = CGRect(x: 14, y: 32, width: b.width - 28, height: 16)
  }

  private func loadPeek(_ s: String) {
    if s.hasPrefix("file://") || s.hasPrefix("/") {
      let url = s.hasPrefix("/") ? URL(fileURLWithPath: s) : URL(string: s)
      if let u = url, let data = try? Data(contentsOf: u) { show(data) }
      return
    }
    guard let url = URL(string: s) else { return }
    var req = URLRequest(url: url)
    req.timeoutInterval = 15
    if !authToken.isEmpty, url.host?.hasSuffix("chatyy.com.br") == true {
      req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    }
    task = URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      guard let data = data, (resp as? HTTPURLResponse)?.statusCode ?? 200 < 400 else { return }
      DispatchQueue.main.async { self?.show(data) }
    }
    task?.resume()
  }

  private func show(_ data: Data) {
    let maxPixel = max(preferredContentSize.width, preferredContentSize.height) * UIScreen.main.scale
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return }
    let img = UIImage(cgImage: cg)
    imageView.alpha = 0
    imageView.image = img
    textLabel.isHidden = true
    UIView.animate(withDuration: 0.18) { self.imageView.alpha = 1 }
  }
}
