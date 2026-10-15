import ExpoModulesCore
import UIKit

// [2026-10-14 native-viewer] Visualizador de mídia NATIVO (Fotos do iOS /
// WhatsApp). O pager JS (FlatList + gestos) do components/ChatMediaViewer.js
// travava no swipe entre fotos; aqui tudo roda em UIKit:
//   UICollectionView paginada (12 pt entre páginas) → página = UIScrollView com
//   zoom (1…4, duplo toque no ponto) ou AVPlayerLayer (vídeo); arrastar p/
//   baixo/cima fecha; barras somem com toque simples.
// JS: ChatyyMediaViewer.open({ items, index, labels, allow* }) → session id.
// Eventos (todos com `session`): onIndexChange {index}, onAction {action,
// index, messageId, starred?}, onClose {index, reason}.
public class ChatyyMediaViewerModule: Module {
  private weak var current: MediaViewerController?
  private var session: Int = 0

  public func definition() -> ModuleDefinition {
    Name("ChatyyMediaViewer")

    Events("onIndexChange", "onAction", "onClose")

    // 2 = aceita `secure` (escudo durante gravação/espelhamento) [2026-10-14 adv-privacy]
    // 3 = `sourceRect`/`sourceRadius` + setReturnRect (hero bolha ↔ viewer) [2026-10-15 hero]
    Function("apiVersion") { () -> Int in
      return 3
    }

    AsyncFunction("open") { (options: [String: Any]) -> Int in
      let rawItems = options["items"] as? [[String: Any]] ?? []
      let items = rawItems.map { MVItem(dict: $0) }
      guard !items.isEmpty else { return 0 }
      // Um viewer por vez: fecha o anterior sem animação ANTES de achar o
      // apresentador (senão o "topo" seria o viewer que está saindo).
      if let old = self.current {
        old.closeSilently()
        self.current = nil
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else { return 0 }

      self.session += 1
      let sid = self.session
      let labels = (options["labels"] as? [String: Any] ?? [:]).reduce(into: [String: String]()) { acc, kv in
        if let s = kv.value as? String { acc[kv.key] = s }
      }
      var flags = MVFlags()
      flags.allowShare = (options["allowShare"] as? Bool) ?? true
      flags.allowSave = (options["allowSave"] as? Bool) ?? true
      flags.allowForward = (options["allowForward"] as? Bool) ?? true
      flags.allowStar = (options["allowStar"] as? Bool) ?? true
      flags.secure = (options["secure"] as? Bool) ?? false
      let startIndex = MVItem.intValue(options["index"]) ?? 0

      let vc = MediaViewerController(
        items: items,
        index: max(0, min(items.count - 1, startIndex)),
        labels: labels,
        flags: flags
      )
      // [2026-10-15 hero] Frame da miniatura na bolha (coordenadas de janela).
      let heroRect = MVItem.rectValue(options["sourceRect"])
      let heroRadius = CGFloat(MVItem.doubleValue(options["sourceRadius"]) ?? 0)
      if let r = heroRect {
        vc.setHeroSource(r, radius: heroRadius)
      }
      vc.onIndexChange = { [weak self] idx in
        self?.sendEvent("onIndexChange", ["session": sid, "index": idx])
      }
      vc.onAction = { [weak self] action, idx, extra in
        var body: [String: Any?] = ["session": sid, "action": action, "index": idx]
        if idx >= 0 && idx < items.count { body["messageId"] = items[idx].messageId }
        for (k, v) in extra { body[k] = v }
        self?.sendEvent("onAction", body)
      }
      vc.onClose = { [weak self] idx, reason in
        self?.sendEvent("onClose", ["session": sid, "index": idx, "reason": reason])
      }
      self.current = vc
      // Hero: o próprio viewer anima (fundo + foto saindo da bolha) — sem o
      // crossDissolve do present por cima.
      // [2026-10-15 screen-protect-all] protege a tela nova já (camada segura; expo-chat-privacy)
      presenter.present(vc, animated: heroRect == nil, completion: {
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      })
      NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      return sid
    }.runOnQueue(.main)

    AsyncFunction("close") { () -> Bool in
      guard let vc = self.current else { return false }
      self.current = nil
      vc.closeFromJS()
      return true
    }.runOnQueue(.main)

    // action: 'save' | 'share' | 'forward' | 'star'; state: 'busy' | 'done' | 'idle'
    AsyncFunction("setActionState") { (action: String, state: String) -> Bool in
      guard let vc = self.current else { return false }
      vc.setActionState(action: action, state: state)
      return true
    }.runOnQueue(.main)

    // [2026-10-15 hero] Para onde a página `index` volta ao fechar; nil = fecha normal.
    AsyncFunction("setReturnRect") { (index: Int, rect: [String: Any]?, radius: Double) -> Bool in
      guard let vc = self.current else { return false }
      vc.setReturnRect(index: index, rect: MVItem.rectValue(rect), radius: CGFloat(radius))
      return true
    }.runOnQueue(.main)

    AsyncFunction("prefetch") { (uris: [String]) -> Bool in
      for u in uris where !u.isEmpty {
        MVImageLoader.shared.prefetch(u, maxPixel: MVImageLoader.fullMaxPixel)
      }
      return true
    }.runOnQueue(.main)
  }
}

struct MVFlags {
  var allowShare = true
  var allowSave = true
  var allowForward = true
  var allowStar = true
  // [2026-10-14 adv-privacy] Privacidade avançada / view-once: tela preta com
  // "Conteúdo protegido" enquanto UIScreen.isCaptured (gravação/espelhamento)
  // e o vídeo pausa. Print não dá para bloquear no iOS (o JS avisa a conversa).
  var secure = false
}

struct MVItem {
  let uri: String
  let localUri: String
  let thumbUri: String
  let isVideo: Bool
  let messageId: String
  let caption: String
  let senderName: String
  let dateLabel: String
  let width: CGFloat
  let height: CGFloat
  var starred: Bool

  init(dict: [String: Any]) {
    uri = (dict["uri"] as? String) ?? ""
    localUri = (dict["localUri"] as? String) ?? ""
    thumbUri = (dict["thumbUri"] as? String) ?? ""
    isVideo = ((dict["type"] as? String) ?? "image") == "video"
    if let s = dict["messageId"] as? String {
      messageId = s
    } else if let n = dict["messageId"] as? NSNumber {
      messageId = n.stringValue
    } else {
      messageId = ""
    }
    caption = (dict["caption"] as? String) ?? ""
    senderName = (dict["senderName"] as? String) ?? ""
    if let d = dict["dateLabel"] as? String, !d.isEmpty {
      dateLabel = d
    } else {
      dateLabel = MVItem.formatDate(dict["createdAt"])
    }
    width = CGFloat(MVItem.doubleValue(dict["width"]) ?? 0)
    height = CGFloat(MVItem.doubleValue(dict["height"]) ?? 0)
    starred = (dict["starred"] as? Bool) ?? false
  }

  static func doubleValue(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) }
    return nil
  }

  /// {x,y,width,height} (pt) → CGRect; nil se ausente/inválido.
  static func rectValue(_ v: Any?) -> CGRect? {
    guard let d = v as? [String: Any],
          let x = doubleValue(d["x"]), let y = doubleValue(d["y"]),
          let w = doubleValue(d["width"]), let h = doubleValue(d["height"]),
          x.isFinite, y.isFinite, w.isFinite, h.isFinite, w >= 2, h >= 2 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
  }

  static func intValue(_ v: Any?) -> Int? {
    if let d = doubleValue(v), d.isFinite { return Int(d) }
    return nil
  }

  private static let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()
  private static let display: DateFormatter = {
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .short
    f.doesRelativeDateFormatting = true
    return f
  }()

  static func formatDate(_ v: Any?) -> String {
    var date: Date?
    if let d = doubleValue(v), d > 0, !(v is String) {
      date = Date(timeIntervalSince1970: d > 1e12 ? d / 1000 : d)
    } else if let s = v as? String, !s.isEmpty {
      date = isoFrac.date(from: s) ?? iso.date(from: s) ?? iso.date(from: s.replacingOccurrences(of: " ", with: "T") + "Z")
    }
    guard let dt = date else { return "" }
    return display.string(from: dt)
  }

  /// file:// (ou caminho absoluto) existente no disco → URL; senão nil.
  static func existingFileURL(_ s: String) -> URL? {
    if s.isEmpty { return nil }
    var url: URL?
    if s.hasPrefix("file://") {
      url = URL(string: s) ?? URL(string: s.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "")
    } else if s.hasPrefix("/") {
      url = URL(fileURLWithPath: s)
    }
    guard let u = url, u.isFileURL, FileManager.default.fileExists(atPath: u.path) else { return nil }
    return u
  }

  static func remoteURL(_ s: String) -> URL? {
    guard s.hasPrefix("http://") || s.hasPrefix("https://") else { return nil }
    if let u = URL(string: s) { return u }
    if let enc = s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { return URL(string: enc) }
    return nil
  }
}
