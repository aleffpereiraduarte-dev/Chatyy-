import ExpoModulesCore
import UIKit
import WebKit

// [2026-10-15 native-email] Corpo do e-mail NATIVO dedicado (nível Apple Mail).
//
// WKWebView próprio, isolado do resto do app:
//   - JS do conteúdo DESLIGADO (WKWebpagePreferences.allowsContentJavaScript =
//     false). Só o nosso script de medida roda, num mundo isolado
//     (WKContentWorld.defaultClient) — o e-mail não enxerga nem chama nada.
//   - Conteúdo remoto bloqueado por padrão com WKContentRuleList (imagens,
//     CSS, fontes, pixels de rastreio). Só os hosts de `allowHosts` (anexos
//     inline cid: do próprio servidor) passam. `blockRemote=false` = "Carregar
//     imagens". O JS também manda uma CSP no <head> (defesa em profundidade).
//   - Armazenamento não persistente (sem cookies/localStorage de remetente).
//   - Altura automática: o script mede o <body> (ResizeObserver + load de
//     imagem) e manda `onContentHeight`; o RN dimensiona a view → um único
//     scroll (o ScrollView do leitor), sem barra dupla.
//   - E-mail mais largo que a tela (newsletter de 600 px) é reduzido para
//     caber (transform no #cy-root, sem reflow) e a pinça amplia (até 4×);
//     com zoom, o próprio WKWebView rola nos dois eixos até voltar a 1×.
//   - Links: toque → `onLinkPress` (o JS abre o navegador interno / mailto /
//     tel); toque longo → menu nativo Abrir / Copiar link / Compartilhar.
//   - Modo escuro: `appearance` = "dark" liga prefers-color-scheme (e-mail que
//     declara suporte); a inversão inteligente vem do CSS montado no JS.
//
// Props:  html, blockRemote, allowHosts[], appearance ("light"|"dark"|"auto"),
//         bgColor (processColor), labels {open, copyLink, share}
// Eventos: onContentHeight {height}, onLinkPress {url}, onLinkLongPress {url},
//          onFirstPaint {ms}, onZoomChange {zoomed, scale}
// Métodos: resetZoom()

public class ChatyyEmailBodyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyEmailBody")

    Function("apiVersion") { () -> Int in
      return 1
    }

    View(ChatyyEmailBodyView.self) {
      Events("onContentHeight", "onLinkPress", "onLinkLongPress", "onFirstPaint", "onZoomChange")

      Prop("html") { (view: ChatyyEmailBodyView, v: String?) in view.pendingHtml = v ?? "" }
      Prop("blockRemote") { (view: ChatyyEmailBodyView, v: Bool?) in view.blockRemote = v ?? true }
      Prop("allowHosts") { (view: ChatyyEmailBodyView, v: [String]?) in view.allowHosts = v ?? [] }
      Prop("appearance") { (view: ChatyyEmailBodyView, v: String?) in view.appearance = v ?? "light" }
      Prop("bgColor") { (view: ChatyyEmailBodyView, v: Double?) in view.bgColorValue = v }
      Prop("labels") { (view: ChatyyEmailBodyView, v: [String: String]?) in view.labels = v ?? [:] }

      OnViewDidUpdateProps { (view: ChatyyEmailBodyView) in
        view.applyProps()
      }

      AsyncFunction("resetZoom") { (view: ChatyyEmailBodyView) in
        view.resetZoom()
      }.runOnQueue(.main)
    }
  }
}

/// processColor() do RN = 0xAARRGGBB.
func cebColor(_ v: Double?, _ fallback: UIColor) -> UIColor {
  guard let v = v, v.isFinite else { return fallback }
  let u = UInt32(truncatingIfNeeded: Int64(v))
  return UIColor(red: CGFloat((u >> 16) & 0xFF) / 255,
                 green: CGFloat((u >> 8) & 0xFF) / 255,
                 blue: CGFloat(u & 0xFF) / 255,
                 alpha: CGFloat((u >> 24) & 0xFF) / 255)
}

/// WKUserContentController retém o handler com força → trampolim fraco.
final class CEBWeakHandler: NSObject, WKScriptMessageHandler {
  weak var target: ChatyyEmailBodyView?
  init(_ t: ChatyyEmailBodyView) { self.target = t }
  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.handleMessage(message)
  }
}

public final class ChatyyEmailBodyView: ExpoView, WKNavigationDelegate, WKUIDelegate {
  let onContentHeight = EventDispatcher()
  let onLinkPress = EventDispatcher()
  let onLinkLongPress = EventDispatcher()
  let onFirstPaint = EventDispatcher()
  let onZoomChange = EventDispatcher()

  var pendingHtml: String = ""
  var blockRemote: Bool = true
  var allowHosts: [String] = []
  var appearance: String = "light"
  var bgColorValue: Double? = nil
  var labels: [String: String] = [:]

  static let handlerName = "chatyyBody"
  private static var sharedStore: WKWebsiteDataStore = WKWebsiteDataStore.nonPersistent()
  private static var ruleCache: [String: WKContentRuleList] = [:]

  private let ucc = WKUserContentController()
  private var webView: WKWebView!
  private var loadedHtml: String? = nil
  private var loadedBlock: Bool? = nil
  private var loadedHosts: [String] = []
  private var loadGen = 0
  private var loadStart: CFTimeInterval = 0
  private var firstPaintSent = false
  private var lastHeight: CGFloat = -1
  private var gotJsHeight = false
  private var zoomObs: NSKeyValueObservation?
  private var zoomed = false

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear

    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = ChatyyEmailBodyView.sharedStore
    cfg.defaultWebpagePreferences.allowsContentJavaScript = false
    cfg.dataDetectorTypes = [.link, .phoneNumber]
    cfg.allowsInlineMediaPlayback = false
    cfg.mediaTypesRequiringUserActionForPlayback = .all
    ucc.add(CEBWeakHandler(self), contentWorld: .defaultClient, name: ChatyyEmailBodyView.handlerName)
    ucc.addUserScript(WKUserScript(source: ChatyyEmailBodyView.measureScript,
                                   injectionTime: .atDocumentEnd,
                                   forMainFrameOnly: true,
                                   in: .defaultClient))
    cfg.userContentController = ucc

    let wv = WKWebView(frame: bounds, configuration: cfg)
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.isOpaque = false
    wv.backgroundColor = .clear
    wv.scrollView.backgroundColor = .clear
    wv.scrollView.contentInsetAdjustmentBehavior = .never
    // 1×: rolagem interna desligada → todo arrasto vai pro ScrollView do
    // leitor (um único scroll). Com zoom de pinça liga p/ passear no conteúdo.
    wv.scrollView.isScrollEnabled = false
    wv.scrollView.bounces = false
    wv.scrollView.alwaysBounceVertical = false
    wv.scrollView.alwaysBounceHorizontal = false
    wv.scrollView.showsVerticalScrollIndicator = false
    wv.scrollView.showsHorizontalScrollIndicator = false
    // Toque na barra de status rola o ScrollView do leitor, não o corpo.
    wv.scrollView.scrollsToTop = false
    wv.scrollView.decelerationRate = .normal
    wv.allowsBackForwardNavigationGestures = false
    // O menu do toque longo é nosso (contextMenuConfigurationForElement).
    wv.allowsLinkPreview = true
    wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(wv)
    webView = wv

    zoomObs = wv.scrollView.observe(\.zoomScale, options: [.new]) { [weak self] sv, _ in
      self?.zoomChanged(sv.zoomScale)
    }
  }

  deinit {
    zoomObs?.invalidate()
    ucc.removeAllScriptMessageHandlers()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    if webView.frame != bounds { webView.frame = bounds }
  }

  // MARK: props

  func applyProps() {
    let bg = cebColor(bgColorValue, .clear)
    backgroundColor = bg
    switch appearance {
    case "dark": webView.overrideUserInterfaceStyle = .dark
    case "auto": webView.overrideUserInterfaceStyle = .unspecified
    default: webView.overrideUserInterfaceStyle = .light
    }
    let html = pendingHtml
    if html == loadedHtml && loadedBlock == blockRemote && loadedHosts == allowHosts { return }
    load(html)
  }

  func resetZoom() {
    let sv = webView.scrollView
    if sv.zoomScale != sv.minimumZoomScale {
      sv.setZoomScale(sv.minimumZoomScale, animated: true)
    }
  }

  private func load(_ html: String) {
    loadGen += 1
    let gen = loadGen
    loadedHtml = html
    loadedBlock = blockRemote
    loadedHosts = allowHosts
    firstPaintSent = false
    gotJsHeight = false
    lastHeight = -1
    loadStart = CACurrentMediaTime()
    ucc.removeAllContentRuleLists()
    let go: () -> Void = { [weak self] in
      guard let self = self, gen == self.loadGen else { return }
      let sv = self.webView.scrollView
      if sv.zoomScale != 1 { sv.setZoomScale(1, animated: false) }
      self.webView.loadHTMLString(html, baseURL: nil)
    }
    if blockRemote {
      ChatyyEmailBodyView.blockRules(allowHosts) { [weak self] list in
        guard let self = self, gen == self.loadGen else { return }
        if let l = list { self.ucc.add(l) }
        go()
      }
    } else {
      go()
    }
  }

  /// Regra única por conjunto de hosts liberados, compilada 1× por processo
  /// (o store em disco também guarda; o identificador é estável).
  private static func blockRules(_ hosts: [String], _ done: @escaping (WKContentRuleList?) -> Void) {
    let clean = hosts.map { $0.lowercased().trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty && $0.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil }
      .sorted()
    let key = clean.joined(separator: ",")
    if let cached = ChatyyEmailBodyView.ruleCache[key] { done(cached); return }
    var rules: [[String: Any]] = [
      ["trigger": ["url-filter": "^https?://"], "action": ["type": "block"]],
    ]
    for h in clean {
      let esc = h.replacingOccurrences(of: ".", with: "\\.")
      rules.append(["trigger": ["url-filter": "^https?://" + esc + "[:/]"],
                    "action": ["type": "ignore-previous-rules"]])
      rules.append(["trigger": ["url-filter": "^https?://[a-z0-9.-]*\\." + esc + "[:/]"],
                    "action": ["type": "ignore-previous-rules"]])
    }
    guard let data = try? JSONSerialization.data(withJSONObject: rules, options: []),
          let json = String(data: data, encoding: .utf8),
          let store = WKContentRuleListStore.default() else {
      done(nil)
      return
    }
    var hash: UInt64 = 5381
    for b in key.utf8 { hash = (hash &* 33) &+ UInt64(b) }
    let ident = "chatyy-email-block-v1-" + String(hash, radix: 16)
    store.compileContentRuleList(forIdentifier: ident, encodedContentRuleList: json) { list, _ in
      DispatchQueue.main.async {
        if let l = list { ChatyyEmailBodyView.ruleCache[key] = l }
        done(list)
      }
    }
  }

  // MARK: height / first paint

  func handleMessage(_ message: WKScriptMessage) {
    guard message.name == ChatyyEmailBodyView.handlerName,
          message.frameInfo.isMainFrame,
          let d = message.body as? [String: Any] else { return }
    let h = (d["h"] as? NSNumber)?.doubleValue ?? 0
    guard h.isFinite, h > 0 else { return }
    gotJsHeight = true
    emitHeight(CGFloat(ceil(h)))
  }

  private func emitHeight(_ h: CGFloat) {
    if abs(h - lastHeight) >= 1 {
      lastHeight = h
      onContentHeight(["height": Double(h)])
    }
    if !firstPaintSent {
      firstPaintSent = true
      onFirstPaint(["ms": (CACurrentMediaTime() - loadStart) * 1000.0])
    }
  }

  private func zoomChanged(_ s: CGFloat) {
    let z = s > webView.scrollView.minimumZoomScale + 0.01
    if z != zoomed {
      zoomed = z
      webView.scrollView.isScrollEnabled = z
      onZoomChange(["zoomed": z, "scale": Double(s)])
    }
  }

  // MARK: WKNavigationDelegate

  public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let gen = loadGen
    // Garante 1 medida mesmo se o ResizeObserver não disparar.
    webView.evaluateJavaScript("window.__cyMeasure ? window.__cyMeasure() : ''", in: nil, in: .defaultClient) { _ in }
    // Rede de segurança: sem resposta do script (CSP/WebKit antigo) → usa o
    // contentSize (pode sobrar espaço, mas nunca corta o corpo).
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      guard let self = self, gen == self.loadGen, !self.gotJsHeight else { return }
      let h = self.webView.scrollView.contentSize.height
      if h > 1 { self.emitHeight(ceil(h)) }
    }
  }

  public func webView(_ webView: WKWebView,
                      decidePolicyFor navigationAction: WKNavigationAction,
                      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
    let scheme = (url.scheme ?? "").lowercased()
    if scheme == "about" {
      decisionHandler(.allow)
      return
    }
    let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
    if navigationAction.navigationType == .linkActivated && mainFrame {
      onLinkPress(["url": url.absoluteString])
    }
    // Todo o resto (meta refresh, form, iframe, redirecionamento) morre aqui.
    decisionHandler(.cancel)
  }

  public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // Processo do WebKit morreu (memória) → recarrega o mesmo HTML.
    loadedHtml = nil
    applyProps()
  }

  // MARK: WKUIDelegate

  public func webView(_ webView: WKWebView,
                      createWebViewWith configuration: WKWebViewConfiguration,
                      for navigationAction: WKNavigationAction,
                      windowFeatures: WKWindowFeatures) -> WKWebView? {
    if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
      onLinkPress(["url": url.absoluteString])
    }
    return nil
  }

  public func webView(_ webView: WKWebView,
                      contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
                      completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) {
    guard let url = elementInfo.linkURL else {
      completionHandler(nil)
      return
    }
    let s = url.absoluteString
    let L = labels
    onLinkLongPress(["url": s])
    let cfg = UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      let open = UIAction(title: L["open"] ?? "Abrir", image: UIImage(systemName: "safari")) { _ in
        self?.onLinkPress(["url": s])
      }
      let copy = UIAction(title: L["copyLink"] ?? "Copiar link", image: UIImage(systemName: "doc.on.doc")) { _ in
        UIPasteboard.general.string = s
        UINotificationFeedbackGenerator().notificationOccurred(.success)
      }
      let share = UIAction(title: L["share"] ?? "Compartilhar", image: UIImage(systemName: "square.and.arrow.up")) { _ in
        self?.share(url)
      }
      let title = s.count > 90 ? String(s.prefix(90)) + "…" : s
      return UIMenu(title: title, children: [open, copy, share])
    }
    completionHandler(cfg)
  }

  private func share(_ url: URL) {
    guard let presenter = appContext?.utilities?.currentViewController() else { return }
    let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    if let pop = vc.popoverPresentationController {
      pop.sourceView = self
      pop.sourceRect = CGRect(x: bounds.midX, y: min(bounds.midY, 200), width: 1, height: 1)
    }
    presenter.present(vc, animated: true, completion: nil)
  }

  // MARK: script (mundo isolado; o e-mail não tem JS)

  // Mede o <body> (margens incluídas) e reduz e-mail largo para caber:
  //   body > #cy-clip (overflow hidden) > #cy-root (conteúdo). Se o conteúdo
  //   natural passa da largura, #cy-root ganha width natural + scale(z) e o
  //   #cy-clip a altura escalada. transform não mexe no layout → sem laço.
  static let measureScript = """
  (function(){
    if (window.__cyMeasure) return;
    var post = function(o){ try { window.webkit.messageHandlers.chatyyBody.postMessage(o); } catch(e) {} };
    var fitW = 0;
    function measure(){
      var b = document.body; if (!b) return null;
      var clip = document.getElementById('cy-clip'), root = document.getElementById('cy-root');
      if (clip && root) {
        var avail = clip.clientWidth;
        var nw = root.scrollWidth;
        if (avail > 0 && nw > Math.max(avail, fitW) + 2) {
          fitW = nw;
          var z = Math.max(0.3, avail / nw);
          root.style.width = nw + 'px';
          root.style.transformOrigin = '0 0';
          root.style.transform = 'scale(' + z + ')';
          root.setAttribute('data-cy-z', String(z));
        }
        var zz = parseFloat(root.getAttribute('data-cy-z') || '1') || 1;
        if (zz !== 1) clip.style.height = Math.ceil(root.offsetHeight * zz) + 'px';
      }
      var cs = getComputedStyle(b);
      var h = b.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      return { h: h, w: document.documentElement.scrollWidth };
    }
    var raf = 0;
    function sched(){ if (raf) return; raf = requestAnimationFrame(function(){ raf = 0; var r = measure(); if (r) post(r); }); }
    window.__cyMeasure = function(){ var r = measure(); if (r) post(r); return r ? JSON.stringify(r) : ''; };
    sched();
    try {
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(sched);
        ro.observe(document.body);
        var rt = document.getElementById('cy-root'); if (rt) ro.observe(rt);
      }
    } catch(e) {}
    document.addEventListener('load', sched, true);
    window.addEventListener('load', sched);
    setTimeout(sched, 350); setTimeout(sched, 1500);
  })();
  """
}
