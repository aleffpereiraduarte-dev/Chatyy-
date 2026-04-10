import ExpoModulesCore
import UIKit
import PDFKit
import WebKit

// MARK: - PDF view module

public class ExpoNativePdfViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativePdfView")
        View(NativePdfView.self) {
            Prop("uri") { (view: NativePdfView, value: String) in view.loadUri(value) }
            Prop("page") { (view: NativePdfView, value: Int) in view.goToPage(value) }
            Prop("showThumbnails") { (view: NativePdfView, value: Bool) in view.setShowThumbnails(value) }
        }
    }
}

public final class NativePdfView: ExpoView {
    private let pdfView = PDFView()
    private let thumbnailView = PDFThumbnailView()
    private var thumbsVisible = false
    private var activeConstraints: [NSLayoutConstraint] = []
    private var currentUri: String?

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.usePageViewController(false)
        addSubview(pdfView)

        thumbnailView.translatesAutoresizingMaskIntoConstraints = false
        thumbnailView.pdfView = pdfView
        thumbnailView.thumbnailSize = CGSize(width: 60, height: 90)
        thumbnailView.layoutMode = .horizontal
        thumbnailView.backgroundColor = UIColor.black.withAlphaComponent(0.6)

        layoutNoThumbs()
    }

    private func layoutNoThumbs() {
        thumbnailView.removeFromSuperview()
        NSLayoutConstraint.deactivate(activeConstraints)
        let c = [
            pdfView.topAnchor.constraint(equalTo: topAnchor),
            pdfView.leadingAnchor.constraint(equalTo: leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: trailingAnchor),
            pdfView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ]
        NSLayoutConstraint.activate(c)
        activeConstraints = c
    }

    private func layoutWithThumbs() {
        NSLayoutConstraint.deactivate(activeConstraints)
        if thumbnailView.superview == nil { addSubview(thumbnailView) }
        let c = [
            pdfView.topAnchor.constraint(equalTo: topAnchor),
            pdfView.leadingAnchor.constraint(equalTo: leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: trailingAnchor),
            pdfView.bottomAnchor.constraint(equalTo: thumbnailView.topAnchor),
            thumbnailView.leadingAnchor.constraint(equalTo: leadingAnchor),
            thumbnailView.trailingAnchor.constraint(equalTo: trailingAnchor),
            thumbnailView.bottomAnchor.constraint(equalTo: bottomAnchor),
            thumbnailView.heightAnchor.constraint(equalToConstant: 90),
        ]
        NSLayoutConstraint.activate(c)
        activeConstraints = c
    }

    func loadUri(_ uri: String) {
        currentUri = uri
        let cleaned = uri.replacingOccurrences(of: "file://", with: "")
        if uri.hasPrefix("http") {
            guard let url = URL(string: uri) else { return }
            let expected = uri
            URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                // Enforce 50MB size limit to prevent OOM
                guard let data = data, data.count <= 50 * 1024 * 1024,
                      let doc = PDFDocument(data: data) else { return }
                DispatchQueue.main.async {
                    guard self?.currentUri == expected else { return }
                    self?.pdfView.document = doc
                }
            }.resume()
        } else if let doc = PDFDocument(url: URL(fileURLWithPath: cleaned)) {
            pdfView.document = doc
        }
    }

    func goToPage(_ index: Int) {
        guard let doc = pdfView.document, index >= 0, index < doc.pageCount, let page = doc.page(at: index) else { return }
        pdfView.go(to: page)
    }

    func setShowThumbnails(_ enabled: Bool) {
        if enabled == thumbsVisible { return }
        thumbsVisible = enabled
        if enabled { layoutWithThumbs() } else { layoutNoThumbs() }
    }
}

// MARK: - HTML email view module

public class ExpoNativeHtmlViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeHtmlView")
        View(NativeHtmlView.self) {
            Events("onRendered")
            Prop("html") { (view: NativeHtmlView, value: String) in view.loadHtml(value) }
            Prop("injectedCss") { (view: NativeHtmlView, value: String?) in view.injectedCss = value }
            Prop("openLinksExternally") { (view: NativeHtmlView, value: Bool) in view.openLinksExternally = value }
        }
    }
}

public final class NativeHtmlView: ExpoView, WKNavigationDelegate {
    private let webView: WKWebView
    var injectedCss: String?
    var openLinksExternally: Bool = false
    let onRendered = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        // Pull from the pre-warmed pool when possible
        if let warm = NativeHtmlView.warmPool.popLast() {
            self.webView = warm
        } else {
            self.webView = WKWebView(frame: .zero, configuration: config)
        }
        super.init(appContext: appContext)
        self.webView.translatesAutoresizingMaskIntoConstraints = false
        self.webView.scrollView.bounces = false
        self.webView.scrollView.showsVerticalScrollIndicator = false
        self.webView.backgroundColor = .clear
        self.webView.isOpaque = false
        self.webView.navigationDelegate = self
        addSubview(self.webView)
        NSLayoutConstraint.activate([
            self.webView.topAnchor.constraint(equalTo: topAnchor),
            self.webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            self.webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            self.webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    func loadHtml(_ html: String) {
        let css = injectedCss ?? "body{font-family:-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#111;padding:0;margin:0}img{max-width:100%;height:auto}a{color:#0a7;text-decoration:none}"
        let wrapped = """
            <!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=yes">
            <style>\(css)</style>
            </head><body>\(html)</body></html>
        """
        webView.loadHTMLString(wrapped, baseURL: nil)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.body.scrollHeight") { [weak self] result, _ in
            if let n = result as? NSNumber {
                self?.onRendered(["contentHeight": n.doubleValue])
            }
        }
    }

    public func webView(_ webView: WKWebView,
                        decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if openLinksExternally,
           navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // ─── Pre-warm pool ────────────────────────────────────────────
    // WhatsApp / Gmail keep ~3 ready WKWebViews so opening an email is
    // instant rather than waiting for the WebKit process to spin up.
    private static var warmPool: [WKWebView] = []
    public static func warmPool(count: Int) {
        DispatchQueue.main.async {
            while warmPool.count < count {
                let wv = WKWebView(frame: .zero)
                warmPool.append(wv)
            }
        }
    }
}

// Pre-warm 2 WKWebViews on app launch
public class HtmlPoolWarmer: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeHtmlPoolWarmer")
        OnCreate {
            NativeHtmlView.warmPool(count: 2)
        }
    }
}
