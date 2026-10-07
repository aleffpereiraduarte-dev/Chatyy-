import ExpoModulesCore
import UIKit
import PDFKit
import WebKit
import CryptoKit

// MARK: - PDF view module
//
// [2026-10-07 native-docs-mail] PDFKit viewer, now a real document viewer:
//   - remote http(s) URIs are DOWNLOADED to Caches/chatyy-pdf/<sha256>.pdf
//     (URLSession download task, optional auth `headers`, 150MB cap) and opened
//     with PDFDocument(url:) — file-backed, so big PDFs don't sit in RAM.
//     Cache key = full URL + headers (never shared across accounts); 3-day prune.
//   - events: onLoad({pageCount}), onError({message}), onPageChange({page, pageCount}).
//   - props are applied in OnViewDidUpdateProps, so `headers` arriving after
//     `uri` in the same commit is still used for the download.
// JS feature-detects this binary via getViewConfig('ExpoNativePdfView') having
// an `onLoad` event (older binaries only had uri/page/showThumbnails).

public class ExpoNativePdfViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativePdfView")
        View(NativePdfView.self) {
            Events("onLoad", "onError", "onPageChange")
            Prop("uri") { (view: NativePdfView, value: String) in view.pendingUri = value }
            Prop("headers") { (view: NativePdfView, value: [String: String]?) in view.headers = value ?? [:] }
            Prop("page") { (view: NativePdfView, value: Int) in view.goToPage(value) }
            Prop("showThumbnails") { (view: NativePdfView, value: Bool) in view.setShowThumbnails(value) }
            OnViewDidUpdateProps { (view: NativePdfView) in view.applyProps() }
        }
    }
}

public final class NativePdfView: ExpoView {
    private let pdfView = PDFView()
    private let thumbnailView = PDFThumbnailView()
    private var thumbsVisible = false
    private var activeConstraints: [NSLayoutConstraint] = []
    private var currentUri: String?
    private var pendingPage: Int?
    private var lastReportedPage = -1
    private var task: URLSessionDownloadTask?
    var pendingUri: String?
    var headers: [String: String] = [:]

    let onLoad = EventDispatcher()
    let onError = EventDispatcher()
    let onPageChange = EventDispatcher()

    public required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.usePageViewController(false)
        pdfView.backgroundColor = .clear
        addSubview(pdfView)

        thumbnailView.translatesAutoresizingMaskIntoConstraints = false
        thumbnailView.pdfView = pdfView
        thumbnailView.thumbnailSize = CGSize(width: 60, height: 90)
        thumbnailView.layoutMode = .horizontal
        thumbnailView.backgroundColor = UIColor.black.withAlphaComponent(0.6)

        layoutNoThumbs()

        NotificationCenter.default.addObserver(self,
                                               selector: #selector(pageChanged(_:)),
                                               name: Notification.Name.PDFViewPageChanged,
                                               object: pdfView)
    }

    deinit {
        task?.cancel()
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

    func applyProps() {
        guard let uri = pendingUri, !uri.isEmpty, uri != currentUri else { return }
        loadUri(uri)
    }

    // Cache key = FULL URL (auth query params included) + headers, hashed.
    // Stripping the token would make two accounts on one device share a cached
    // attachment (same uid/folder/part) — cross-account leak. Files older than
    // 3 days are pruned on each download.
    private static func cacheFile(for url: URL, headers: [String: String]) -> URL {
        var keySource = url.absoluteString
        for k in headers.keys.sorted() { keySource += "\n\(k.lowercased()):\(headers[k] ?? "")" }
        let digest = SHA256.hash(data: Data(keySource.utf8)).map { String(format: "%02x", $0) }.joined()
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = caches.appendingPathComponent("chatyy-pdf", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(digest + ".pdf")
    }

    private static func pruneCache(keeping keep: URL) {
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            let dir = keep.deletingLastPathComponent()
            guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
            let cutoff = Date().addingTimeInterval(-3 * 24 * 3600)
            for item in items where item.lastPathComponent != keep.lastPathComponent {
                let mod = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
                if mod < cutoff { try? fm.removeItem(at: item) }
            }
        }
    }

    // nonisolated: called from URLSession's background completion; hops to main.
    nonisolated private func fail(_ message: String, _ expected: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.currentUri == expected else { return }
            self.onError(["message": message])
        }
    }

    private func openFile(_ fileUrl: URL, expected: String, deleteOnFailure: Bool) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let doc = PDFDocument(url: fileUrl)
            if doc == nil && deleteOnFailure { try? FileManager.default.removeItem(at: fileUrl) }
            DispatchQueue.main.async {
                guard let self = self, self.currentUri == expected else { return }
                guard let doc = doc else { self.onError(["message": "invalid_pdf"]); return }
                if doc.isLocked { self.onError(["message": "locked"]); return }
                self.pdfView.document = doc
                self.lastReportedPage = -1
                if let p = self.pendingPage { self.pendingPage = nil; self.goToPage(p) }
                self.onLoad(["pageCount": doc.pageCount])
                self.reportPage()
            }
        }
    }

    func loadUri(_ uri: String) {
        currentUri = uri
        task?.cancel()
        task = nil
        let expected = uri
        if uri.hasPrefix("http://") || uri.hasPrefix("https://") {
            guard let url = URL(string: uri) else { fail("bad_url", expected); return }
            let dest = NativePdfView.cacheFile(for: url, headers: headers)
            NativePdfView.pruneCache(keeping: dest)
            if let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path),
               let size = attrs[.size] as? NSNumber, size.intValue > 0 {
                openFile(dest, expected: expected, deleteOnFailure: true)
                return
            }
            var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
            let t = URLSession.shared.downloadTask(with: req) { [weak self] tmp, response, error in
                if let error = error as NSError? {
                    if error.code == NSURLErrorCancelled { return }
                    self?.fail(error.localizedDescription, expected)
                    return
                }
                if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                    self?.fail("http_\(http.statusCode)", expected)
                    return
                }
                guard let tmp = tmp else { self?.fail("no_data", expected); return }
                let size = ((try? FileManager.default.attributesOfItem(atPath: tmp.path))?[.size] as? NSNumber)?.intValue ?? 0
                if size <= 0 || size > 150 * 1024 * 1024 {
                    self?.fail(size <= 0 ? "empty" : "too_large", expected)
                    return
                }
                try? FileManager.default.removeItem(at: dest)
                do {
                    try FileManager.default.moveItem(at: tmp, to: dest)
                } catch {
                    self?.fail("cache_write_failed", expected)
                    return
                }
                DispatchQueue.main.async {
                    self?.openFile(dest, expected: expected, deleteOnFailure: true)
                }
            }
            task = t
            t.resume()
        } else {
            let fileUrl: URL
            if uri.hasPrefix("file://"), let u = URL(string: uri) {
                fileUrl = u
            } else {
                fileUrl = URL(fileURLWithPath: uri)
            }
            openFile(fileUrl, expected: expected, deleteOnFailure: false)
        }
    }

    func goToPage(_ index: Int) {
        guard let doc = pdfView.document else { pendingPage = index; return }
        guard index >= 0, index < doc.pageCount, let page = doc.page(at: index) else { return }
        pdfView.go(to: page)
    }

    @objc private func pageChanged(_ note: Notification) {
        reportPage()
    }

    private func reportPage() {
        guard let doc = pdfView.document, let page = pdfView.currentPage else { return }
        let idx = doc.index(for: page)
        if idx == lastReportedPage { return }
        lastReportedPage = idx
        onPageChange(["page": idx, "pageCount": doc.pageCount])
    }

    func setShowThumbnails(_ enabled: Bool) {
        if enabled == thumbsVisible { return }
        thumbsVisible = enabled
        if enabled { layoutWithThumbs() } else { layoutNoThumbs() }
    }
}

// MARK: - HTML email view module
//
// [2026-10-07 native-docs-mail] WKWebView email body, upgraded:
//   - `interceptLinks` + onLinkPress({url}): every user-activated navigation
//     (incl. target=_blank) is CANCELLED and handed to JS, which opens it in
//     the in-app browser sheet (SFSafariViewController) / mailto handler.
//     Without `interceptLinks` the legacy `openLinksExternally` path stays.
//   - viewport locked (user-scalable=no) + pinch disabled: the body lives in a
//     native ScrollView, so it must behave like a native text block.
//   - robust auto-height: a WKUserScript measures the body (ResizeObserver +
//     MutationObserver + capture-phase <img> load/error + fonts.ready + window
//     load) and posts the height through a WKScriptMessageHandler. Every change
//     is emitted as onRendered({contentHeight}) — same event old JS listens to.
//     Height is measured from the body box, not documentElement.scrollHeight
//     (which is clamped to the viewport and could never SHRINK).
//   - `darkMode` + `darkCss`: overrideUserInterfaceStyle (so the email's own
//     prefers-color-scheme rules apply) and extra CSS appended in dark mode.
//   - props are applied in OnViewDidUpdateProps, so injectedCss/darkCss always
//     land with the html no matter the prop order.

public class ExpoNativeHtmlViewModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoNativeHtmlView")
        View(NativeHtmlView.self) {
            Events("onRendered", "onLinkPress")
            Prop("html") { (view: NativeHtmlView, value: String) in view.setHtml(value) }
            Prop("injectedCss") { (view: NativeHtmlView, value: String?) in view.setInjectedCss(value) }
            Prop("openLinksExternally") { (view: NativeHtmlView, value: Bool) in view.openLinksExternally = value }
            Prop("interceptLinks") { (view: NativeHtmlView, value: Bool) in view.interceptLinks = value }
            Prop("darkMode") { (view: NativeHtmlView, value: Bool) in view.setDarkMode(value) }
            Prop("darkCss") { (view: NativeHtmlView, value: String?) in view.setDarkCss(value) }
            Prop("scrollEnabled") { (view: NativeHtmlView, value: Bool) in view.setScrollEnabled(value) }
            OnViewDidUpdateProps { (view: NativeHtmlView) in view.reloadIfNeeded() }
        }
    }
}

// WKUserContentController retains its handlers strongly; this proxy breaks the
// webView -> controller -> view cycle.
final class NativeHtmlWeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: NativeHtmlView?
    init(_ target: NativeHtmlView) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.handleScriptMessage(message)
    }
}

public final class NativeHtmlView: ExpoView, WKNavigationDelegate, WKUIDelegate {
    private static let heightHandlerName = "chatyyHeight"
    private static let heightScript = """
    (function(){
      if (window.__chatyyH) return; window.__chatyyH = 1;
      var last = 0, pend = false;
      function measure(){
        var b = document.body; if (!b) return 0;
        var cs = window.getComputedStyle(b);
        var mt = parseFloat(cs.marginTop) || 0, mb = parseFloat(cs.marginBottom) || 0;
        var r = b.getBoundingClientRect();
        var y = window.scrollY || 0;
        var h = Math.max(r.bottom + y + mb, b.scrollHeight + mt + mb, b.offsetHeight + mt + mb);
        return Math.ceil(h);
      }
      window.__chatyyMeasure = measure;
      function post(){
        pend = false;
        var h = measure();
        if (h > 0 && Math.abs(h - last) > 1) {
          last = h;
          try { window.webkit.messageHandlers.chatyyHeight.postMessage(h); } catch (e) {}
        }
      }
      function sched(){ if (pend) return; pend = true; (window.requestAnimationFrame || setTimeout)(post); }
      try { new ResizeObserver(sched).observe(document.body); } catch (e) {}
      try { new MutationObserver(sched).observe(document.body, {childList:true, subtree:true, attributes:true, characterData:true}); } catch (e) {}
      document.addEventListener('load', sched, true);
      document.addEventListener('error', sched, true);
      window.addEventListener('load', function(){ sched(); setTimeout(sched, 250); setTimeout(sched, 1000); setTimeout(sched, 2500); });
      try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(sched); } catch (e) {}
      sched();
    })();
    """

    private let webView: WKWebView
    private var scriptHandler: NativeHtmlWeakScriptHandler?
    private var html: String?
    private var injectedCss: String?
    private var darkMode: Bool = false
    private var darkCss: String?
    private var needsReload = false
    private var lastLinkUrl: String?
    private var lastLinkAt: TimeInterval = 0
    var openLinksExternally: Bool = false
    var interceptLinks: Bool = false
    let onRendered = EventDispatcher()
    let onLinkPress = EventDispatcher()

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
        // Keep one warm view ready for the next email.
        NativeHtmlView.warmPool(count: 1)
        self.webView.translatesAutoresizingMaskIntoConstraints = false
        self.webView.scrollView.bounces = false
        self.webView.scrollView.showsVerticalScrollIndicator = false
        self.webView.scrollView.showsHorizontalScrollIndicator = false
        self.webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        self.webView.scrollView.contentInsetAdjustmentBehavior = .never
        self.webView.backgroundColor = .clear
        self.webView.isOpaque = false
        self.webView.allowsLinkPreview = false
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self

        let ucc = self.webView.configuration.userContentController
        ucc.removeScriptMessageHandler(forName: NativeHtmlView.heightHandlerName)
        let handler = NativeHtmlWeakScriptHandler(self)
        ucc.add(handler, name: NativeHtmlView.heightHandlerName)
        self.scriptHandler = handler
        ucc.addUserScript(WKUserScript(source: NativeHtmlView.heightScript,
                                       injectionTime: .atDocumentEnd,
                                       forMainFrameOnly: true))

        addSubview(self.webView)
        NSLayoutConstraint.activate([
            self.webView.topAnchor.constraint(equalTo: topAnchor),
            self.webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            self.webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            self.webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    // ─── Props ────────────────────────────────────────────────────
    func setHtml(_ value: String) {
        if value != html { html = value; needsReload = true }
    }
    func setInjectedCss(_ value: String?) {
        if value != injectedCss { injectedCss = value; needsReload = true }
    }
    func setDarkMode(_ value: Bool) {
        webView.overrideUserInterfaceStyle = value ? .dark : .light
        if value != darkMode { darkMode = value; needsReload = true }
    }
    func setDarkCss(_ value: String?) {
        if value != darkCss { darkCss = value; if darkMode { needsReload = true } }
    }
    func setScrollEnabled(_ value: Bool) {
        webView.scrollView.isScrollEnabled = value
    }

    func reloadIfNeeded() {
        guard needsReload, let html = html else { return }
        needsReload = false
        loadHtml(html)
    }

    private func loadHtml(_ html: String) {
        var css = injectedCss ?? "body{font-family:-apple-system,sans-serif;font-size:15px;line-height:1.5;color:#111;padding:0;margin:0}img{max-width:100%;height:auto}a{color:#0a7;text-decoration:none}"
        css += darkMode ? ":root{color-scheme:dark}" : ":root{color-scheme:light}"
        if darkMode, let extra = darkCss { css += extra }
        // `</style` inside the CSS would close the tag early.
        css = css.replacingOccurrences(of: "</style", with: "<\\/style", options: .caseInsensitive)
        let wrapped = """
            <!DOCTYPE html><html><head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
            <style>\(css)</style>
            </head><body>\(html)</body></html>
        """
        webView.loadHTMLString(wrapped, baseURL: nil)
    }

    // ─── Height ───────────────────────────────────────────────────
    func handleScriptMessage(_ message: WKScriptMessage) {
        guard message.name == NativeHtmlView.heightHandlerName else { return }
        if let n = message.body as? NSNumber, n.doubleValue > 0 {
            onRendered(["contentHeight": n.doubleValue])
        }
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let js = "(window.__chatyyMeasure ? window.__chatyyMeasure() : document.body.scrollHeight)"
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            if let n = result as? NSNumber, n.doubleValue > 0 {
                self?.onRendered(["contentHeight": n.doubleValue])
            }
        }
    }

    // ─── Links ────────────────────────────────────────────────────
    private func emitLink(_ url: URL) {
        let s = url.absoluteString
        let now = Date().timeIntervalSince1970
        if s == lastLinkUrl && now - lastLinkAt < 0.6 { return }
        lastLinkUrl = s
        lastLinkAt = now
        onLinkPress(["url": s])
    }

    private static func isInternal(_ url: URL?) -> Bool {
        guard let url = url else { return true }
        let scheme = (url.scheme ?? "").lowercased()
        return scheme == "about" || scheme == "data" || scheme == "blob" || url.absoluteString.isEmpty
    }

    public func webView(_ webView: WKWebView,
                        decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if interceptLinks {
            if NativeHtmlView.isInternal(url) {
                decisionHandler(.allow)
                return
            }
            let userTap = navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil
            let isMain = navigationAction.targetFrame?.isMainFrame ?? true
            if userTap, let url = url {
                emitLink(url)
                decisionHandler(.cancel)
                return
            }
            // Never let the email navigate the main frame away (meta refresh,
            // form posts, JS redirects). Sub-resources/iframes are untouched.
            if isMain {
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }
        if openLinksExternally,
           navigationAction.navigationType == .linkActivated,
           let url = url {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // target=_blank / window.open: never spawn a new web view.
    public func webView(_ webView: WKWebView,
                        createWebViewWith configuration: WKWebViewConfiguration,
                        for navigationAction: WKNavigationAction,
                        windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, !NativeHtmlView.isInternal(url) {
            if interceptLinks {
                emitLink(url)
            } else if openLinksExternally {
                UIApplication.shared.open(url)
            }
        }
        return nil
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
