import ExpoModulesCore
import UIKit
import LinkPresentation

// MARK: ─── 1. LPLinkView (Apple Open Graph link preview) ────────────────

public class ExpoNativeLinkPreviewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeLinkPreview")
        View(NativeLinkPreview.self) {
            Events("onTap", "onLoad", "onError")
            Prop("url") { (view: NativeLinkPreview, value: String) in view.loadUrl(value) }
        }
    }
}

public final class NativeLinkPreview: ExpoView {
    private var linkView: LPLinkView?
    let onTap = EventDispatcher()
    let onLoad = EventDispatcher()
    let onError = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = .clear
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        linkView?.frame = bounds
    }

    func loadUrl(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        // Try a cached metadata first via shared in-memory cache
        if let cached = NativeLinkPreview.cache[urlString] {
            install(metadata: cached)
            onLoad(["cached": true])
            return
        }
        let provider = LPMetadataProvider()
        provider.shouldFetchSubresources = true
        provider.timeout = 10
        provider.startFetchingMetadata(for: url) { [weak self] meta, err in
            guard let self = self else { return }
            DispatchQueue.main.async {
                if let meta = meta {
                    NativeLinkPreview.cache[urlString] = meta
                    self.install(metadata: meta)
                    self.onLoad(["cached": false])
                } else {
                    self.onError(["message": err?.localizedDescription ?? "fetch failed"])
                }
            }
        }
    }

    private func install(metadata: LPLinkMetadata) {
        let lv = LPLinkView(metadata: metadata)
        lv.frame = bounds
        if let old = linkView { old.removeFromSuperview() }
        addSubview(lv)
        linkView = lv

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        lv.addGestureRecognizer(tap)
        lv.isUserInteractionEnabled = true
    }

    @objc private func handleTap() { onTap([:]) }

    private static var cache: [String: LPLinkMetadata] = [:]
}

// MARK: ─── 2. Typing indicator view (3 bouncing dots) ─────────────────

public class ExpoNativeTypingIndicatorModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeTypingIndicator")
        View(NativeTypingIndicator.self) {
            Prop("color") { (view: NativeTypingIndicator, value: String?) in
                view.dotColor = ExpoNativeChatPolishHelpers.color(from: value ?? "#999999")
                view.setNeedsLayout()
            }
            Prop("animating") { (view: NativeTypingIndicator, value: Bool) in
                view.setAnimating(value)
            }
        }
    }
}

public final class NativeTypingIndicator: ExpoView {
    private let dots: [CALayer] = [CALayer(), CALayer(), CALayer()]
    var dotColor: UIColor = UIColor(red: 0.6, green: 0.6, blue: 0.6, alpha: 1) {
        didSet { dots.forEach { $0.backgroundColor = dotColor.cgColor } }
    }

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = .clear
        for d in dots {
            d.backgroundColor = dotColor.cgColor
            d.cornerRadius = 4
            layer.addSublayer(d)
        }
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let dotSize: CGFloat = 8
        let gap: CGFloat = 6
        let totalW = dotSize * 3 + gap * 2
        let startX = (bounds.width - totalW) / 2
        let y = (bounds.height - dotSize) / 2
        for (i, d) in dots.enumerated() {
            d.frame = CGRect(x: startX + CGFloat(i) * (dotSize + gap), y: y,
                              width: dotSize, height: dotSize)
        }
    }

    func setAnimating(_ animating: Bool) {
        if !animating {
            dots.forEach { $0.removeAllAnimations() }
            return
        }
        for (i, d) in dots.enumerated() {
            let anim = CAKeyframeAnimation(keyPath: "transform.translation.y")
            anim.values = [0, -4, 0]
            anim.keyTimes = [0, 0.5, 1]
            anim.duration = 0.9
            anim.repeatCount = .infinity
            anim.beginTime = CACurrentMediaTime() + Double(i) * 0.15
            d.add(anim, forKey: "bounce")
        }
    }
}

// MARK: ─── 3. Skeleton row (CAGradientLayer shimmer) ──────────────────

public class ExpoNativeSkeletonModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeSkeleton")
        View(NativeSkeletonView.self) {
            Prop("variant") { (view: NativeSkeletonView, value: String) in view.variant = value; view.setNeedsLayout() }
        }
    }
}

public final class NativeSkeletonView: ExpoView {
    var variant: String = "chatRow"
    private let shimmerLayer = CAGradientLayer()
    private var blocks: [CALayer] = []

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = .clear

        shimmerLayer.colors = [
            UIColor(white: 1, alpha: 0).cgColor,
            UIColor(white: 1, alpha: 0.35).cgColor,
            UIColor(white: 1, alpha: 0).cgColor,
        ]
        shimmerLayer.startPoint = CGPoint(x: 0, y: 0.5)
        shimmerLayer.endPoint = CGPoint(x: 1, y: 0.5)
        shimmerLayer.locations = [0.0, 0.5, 1.0]

        let shimmer = CABasicAnimation(keyPath: "locations")
        shimmer.fromValue = [-1.0, -0.5, 0.0]
        shimmer.toValue = [1.0, 1.5, 2.0]
        shimmer.duration = 1.4
        shimmer.repeatCount = .infinity
        shimmerLayer.add(shimmer, forKey: "shimmer")
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        blocks.forEach { $0.removeFromSuperlayer() }
        blocks.removeAll()

        let blockColor = UIColor(white: 0.85, alpha: 1).cgColor

        switch variant {
        case "chatRow":
            // Avatar circle
            let avatar = CALayer()
            avatar.frame = CGRect(x: 12, y: 12, width: 48, height: 48)
            avatar.cornerRadius = 24
            avatar.backgroundColor = blockColor
            layer.addSublayer(avatar)
            blocks.append(avatar)
            // Title bar
            let title = CALayer()
            title.frame = CGRect(x: 72, y: 18, width: bounds.width * 0.4, height: 14)
            title.cornerRadius = 4
            title.backgroundColor = blockColor
            layer.addSublayer(title)
            blocks.append(title)
            // Subtitle bar
            let subtitle = CALayer()
            subtitle.frame = CGRect(x: 72, y: 40, width: bounds.width * 0.6, height: 12)
            subtitle.cornerRadius = 4
            subtitle.backgroundColor = blockColor
            layer.addSublayer(subtitle)
            blocks.append(subtitle)
        case "messageBubble":
            let bubble = CALayer()
            bubble.frame = CGRect(x: 12, y: 8, width: bounds.width * 0.55, height: 38)
            bubble.cornerRadius = 16
            bubble.backgroundColor = blockColor
            layer.addSublayer(bubble)
            blocks.append(bubble)
        default:
            break
        }

        shimmerLayer.frame = bounds
        if shimmerLayer.superlayer == nil {
            layer.addSublayer(shimmerLayer)
        }
        // Mask the shimmer to the blocks
        let mask = CALayer()
        mask.frame = bounds
        for b in blocks {
            let maskBlock = CALayer()
            maskBlock.frame = b.frame
            maskBlock.cornerRadius = b.cornerRadius
            maskBlock.backgroundColor = UIColor.black.cgColor
            mask.addSublayer(maskBlock)
        }
        shimmerLayer.mask = mask
    }
}

// MARK: ─── 4. Wallpaper view (per-chat background image) ─────────────

public class ExpoNativeWallpaperModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeWallpaper")
        View(NativeWallpaperView.self) {
            Prop("uri") { (view: NativeWallpaperView, value: String?) in view.loadUri(value) }
            Prop("dim") { (view: NativeWallpaperView, value: Double) in
                view.dimView.alpha = CGFloat(max(0, min(1, value)))
            }
            Prop("color") { (view: NativeWallpaperView, value: String?) in
                view.backgroundColor = ExpoNativeChatPolishHelpers.color(from: value ?? "#0b141a")
            }
        }
    }
}

public final class NativeWallpaperView: ExpoView {
    private let imageView = UIImageView()
    let dimView = UIView()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        backgroundColor = UIColor(red: 0.04, green: 0.08, blue: 0.10, alpha: 1)

        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        addSubview(imageView)

        dimView.translatesAutoresizingMaskIntoConstraints = false
        dimView.backgroundColor = UIColor.black
        dimView.alpha = 0.35
        addSubview(dimView)

        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
            dimView.topAnchor.constraint(equalTo: topAnchor),
            dimView.leadingAnchor.constraint(equalTo: leadingAnchor),
            dimView.trailingAnchor.constraint(equalTo: trailingAnchor),
            dimView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    func loadUri(_ uri: String?) {
        guard let uri = uri, !uri.isEmpty else {
            imageView.image = nil
            return
        }
        if uri.hasPrefix("http") {
            guard let url = URL(string: uri) else { return }
            URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                guard let data = data, let img = UIImage(data: data) else { return }
                DispatchQueue.main.async { self?.imageView.image = img }
            }.resume()
        } else {
            let cleaned = uri.replacingOccurrences(of: "file://", with: "")
            imageView.image = UIImage(contentsOfFile: cleaned)
        }
    }
}

// MARK: ─── 5. Universal Clipboard + Handoff helpers (in toolkit) ─────

public class ExpoNativeClipboardHandoffModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeClipboardHandoff")

        // Universal Clipboard — UIPasteboard.general items sync across
        // iPhone/iPad/Mac via the user's iCloud account automatically.
        Function("copyText") { (text: String) in
            UIPasteboard.general.string = text
        }
        Function("copyImage") { (uri: String) in
            let cleaned = uri.replacingOccurrences(of: "file://", with: "")
            if let img = UIImage(contentsOfFile: cleaned) {
                UIPasteboard.general.image = img
            }
        }
        Function("copyUrl") { (urlString: String) in
            if let url = URL(string: urlString) {
                UIPasteboard.general.url = url
            }
        }
        Function("getClipboardTextSync") { () -> String in
            return UIPasteboard.general.string ?? ""
        }

        // Handoff — NSUserActivity that lets the user continue from
        // iPhone to Mac (or vice versa) on the same conversation.
        Function("startHandoff") { (activityType: String, title: String, urlString: String) in
            DispatchQueue.main.async {
                let activity = NSUserActivity(activityType: activityType)
                activity.title = title
                if let url = URL(string: urlString) { activity.webpageURL = url }
                activity.isEligibleForHandoff = true
                activity.isEligibleForSearch = true
                activity.becomeCurrent()
                ExpoNativeChatPolishHelpers.currentActivity = activity
            }
        }
        Function("stopHandoff") {
            DispatchQueue.main.async {
                ExpoNativeChatPolishHelpers.currentActivity?.invalidate()
                ExpoNativeChatPolishHelpers.currentActivity = nil
            }
        }
    }
}

// MARK: ─── Shared helpers ─────────────────────────────────────────────

class ExpoNativeChatPolishHelpers {
    static var currentActivity: NSUserActivity?

    static func color(from hex: String) -> UIColor {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgb)
        let r = CGFloat((rgb & 0xff0000) >> 16) / 255.0
        let g = CGFloat((rgb & 0x00ff00) >> 8) / 255.0
        let b = CGFloat(rgb & 0x0000ff) / 255.0
        return UIColor(red: r, green: g, blue: b, alpha: 1)
    }
}
