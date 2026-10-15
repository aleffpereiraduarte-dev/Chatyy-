import ExpoModulesCore
import UIKit

// [2026-10-15 native-status-studio] Criador de STATUS nativo.
// JS: modules/expo-status-studio/index.ts → ChatyyStatusStudio.open(options)
// → Promise<result> resolvida UMA vez ('publish' | 'cancel' | 'camera' |
// 'editAudience' | 'error'); null = não apresentou (JS usa o estúdio JS).
// Pedidos ao JS (busca de música, galeria, localização) saem pelo evento
// onRequest { reqId, kind, q? } e voltam por respond(reqId, data).
public class ChatyyStatusStudioModule: Module {
  private weak var current: SSStudioController?
  private var nextReq = 0
  private var pending: [Int: ([String: Any]) -> Void] = [:]

  public func definition() -> ModuleDefinition {
    Name("ChatyyStatusStudio")

    Events("onRequest")

    Function("apiVersion") { () -> Int in
      return 1
    }

    AsyncFunction("open") { (options: [String: Any], promise: Promise) in
      if let old = self.current {
        self.current = nil
        old.closeFromJS()
      }
      self.failPending()
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(nil)
        return
      }
      let opts = SSOptions(options)
      let vc = SSStudioController(options: opts)
      var settled = false
      vc.onFinish = { [weak self] result in
        if settled { return }
        settled = true
        self?.failPending()
        promise.resolve(result)
      }
      vc.request = { [weak self] kind, params, cb in
        guard let self = self else { cb([:]); return }
        self.nextReq += 1
        let id = self.nextReq
        self.pending[id] = cb
        var body: [String: Any] = ["reqId": id, "kind": kind]
        for (k, v) in params { body[k] = v }
        self.sendEvent("onRequest", body as [String: Any?])
      }
      self.current = vc
      vc.modalPresentationStyle = .fullScreen
      // [2026-10-15 screen-protect-all] protege a tela nova já (camada segura; expo-chat-privacy)
      presenter.present(vc, animated: true, completion: {
        NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      })
      NotificationCenter.default.post(name: Notification.Name("ChatyyScreenProtectRescan"), object: nil)
      // Apresentação recusada (outro modal saindo) → JS cai no estúdio JS.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak vc] in
        guard !settled else { return }
        if vc == nil || vc?.presentingViewController == nil {
          settled = true
          promise.resolve(nil)
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("respond") { (reqId: Int, data: [String: Any]) -> Bool in
      guard let cb = self.pending.removeValue(forKey: reqId) else { return false }
      cb(data)
      return true
    }.runOnQueue(.main)

    AsyncFunction("close") { () -> Bool in
      guard let vc = self.current else { return false }
      self.current = nil
      vc.closeFromJS()
      return true
    }.runOnQueue(.main)
  }

  private func failPending() {
    let p = pending
    pending.removeAll()
    for (_, cb) in p { cb([:]) }
  }
}

// MARK: - Opções

struct SSFilter {
  let id: String
  let label: String
  let m: [CGFloat]?

  var isIdentity: Bool {
    guard let m = m, m.count == 20 else { return true }
    let id: [CGFloat] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]
    for i in 0..<20 where abs(m[i] - id[i]) > 0.0001 { return false }
    return true
  }
}

struct SSTextBackground {
  let value: String
  let colors: [UIColor]
}

struct SSTrack {
  let id: String
  let title: String
  let artist: String
  let previewUrl: String
  let coverUrl: String
  let durationSec: Double

  init(_ d: [String: Any]) {
    if let n = d["id"] as? NSNumber { id = n.stringValue } else { id = (d["id"] as? String) ?? "" }
    title = (d["title"] as? String) ?? ""
    artist = (d["artist"] as? String) ?? ""
    previewUrl = (d["previewUrl"] as? String) ?? (d["preview_url"] as? String) ?? ""
    coverUrl = (d["coverUrl"] as? String) ?? (d["cover_url"] as? String) ?? (d["image_url"] as? String) ?? ""
    durationSec = SSOptions.num(d["durationSec"]) ?? SSOptions.num(d["duration_sec"]) ?? 0
  }

  var dict: [String: Any] {
    return ["title": title, "artist": artist, "previewUrl": previewUrl, "coverUrl": coverUrl]
  }
}

struct SSMediaIn {
  let uri: String
  let isVideo: Bool
  let width: CGFloat
  let height: CGFloat
  let filter: String
  let boomerang: Bool

  init?(_ d: [String: Any]) {
    guard let u = d["uri"] as? String, !u.isEmpty else { return nil }
    uri = u
    let t = ((d["type"] as? String) ?? "image").lowercased()
    isVideo = t == "video" || t.hasPrefix("video/")
    width = CGFloat(SSOptions.num(d["width"]) ?? 0)
    height = CGFloat(SSOptions.num(d["height"]) ?? 0)
    filter = (d["filter"] as? String) ?? ""
    boomerang = (d["boomerang"] as? Bool) ?? false
  }
}

final class SSOptions {
  let mode: String
  let items: [SSMediaIn]
  let labels: [String: String]
  let filters: [SSFilter]
  let textBackgrounds: [SSTextBackground]
  let textBgIndex: Int
  let fonts: [(id: String, label: String)]
  let textMax: Int
  let palette: [UIColor]
  let paletteHex: [String]
  let emojis: [String]
  let contacts: [(email: String, name: String)]
  let musicCatalog: [SSTrack]
  let music: [String: Any]?
  let audience: String
  let closeFriendsCount: Int
  let exceptCount: Int
  let canCamera: Bool
  let canGallery: Bool

  init(_ o: [String: Any]) {
    mode = (o["mode"] as? String) == "text" ? "text" : "media"
    items = ((o["items"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any]).flatMap { SSMediaIn($0) } }.prefix(10).map { $0 }
    var l: [String: String] = [:]
    if let raw = o["labels"] as? [String: Any] {
      for (k, v) in raw { if let s = v as? String { l[k] = s } }
    }
    labels = l
    var fs: [SSFilter] = []
    for raw in (o["filters"] as? [Any]) ?? [] {
      guard let d = raw as? [String: Any], let id = d["id"] as? String else { continue }
      let m = (d["m"] as? [Any])?.compactMap { SSOptions.num($0).map { CGFloat($0) } }
      fs.append(SSFilter(id: id, label: (d["label"] as? String) ?? id, m: (m?.count == 20) ? m : nil))
    }
    if fs.isEmpty || fs[0].id != "original" {
      fs.insert(SSFilter(id: "original", label: "Original", m: nil), at: 0)
    }
    filters = fs
    var bgs: [SSTextBackground] = []
    for raw in (o["textBackgrounds"] as? [Any]) ?? [] {
      guard let d = raw as? [String: Any], let v = d["value"] as? String else { continue }
      let cols = ((d["colors"] as? [Any]) ?? []).compactMap { UIColor.ss_hex($0 as? String) }
      if cols.isEmpty { if let c = UIColor.ss_hex(v) { bgs.append(SSTextBackground(value: v, colors: [c])) }; continue }
      bgs.append(SSTextBackground(value: v, colors: cols))
    }
    if bgs.isEmpty {
      bgs = ["#111111", "#54656F", "#0F766E", "#15803D", "#0E7490", "#2563EB", "#4F46E5", "#7C3AED", "#C026D3", "#DB2777", "#DC2626", "#EA580C"]
        .map { SSTextBackground(value: $0, colors: [UIColor.ss_hex($0) ?? .black]) }
    }
    textBackgrounds = bgs
    textBgIndex = max(0, min(bgs.count - 1, Int(SSOptions.num(o["textBgIndex"]) ?? 0)))
    var fo: [(String, String)] = []
    for raw in (o["fonts"] as? [Any]) ?? [] {
      guard let d = raw as? [String: Any], let id = d["id"] as? String else { continue }
      fo.append((id, (d["label"] as? String) ?? id))
    }
    if fo.isEmpty { fo = [("sans", "Padrão"), ("serif", "Serifa"), ("mono", "Máquina"), ("script", "Manuscrita"), ("condensed", "Condensada")] }
    fonts = fo.map { (id: $0.0, label: $0.1) }
    textMax = max(1, Int(SSOptions.num(o["textMax"]) ?? 700))
    var ph = ((o["palette"] as? [Any]) ?? []).compactMap { $0 as? String }.filter { UIColor.ss_hex($0) != nil }
    if ph.isEmpty { ph = ["#FFFFFF", "#000000", "#9CA3AF", "#EF4444", "#F97316", "#FACC15", "#22C55E", "#14B8A6", "#3B82F6", "#8B5CF6", "#EC4899"] }
    paletteHex = ph
    palette = ph.compactMap { UIColor.ss_hex($0) }
    let em = ((o["emojis"] as? [Any]) ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty }
    emojis = em.isEmpty ? SSOptions.defaultEmojis : em
    contacts = ((o["contacts"] as? [Any]) ?? []).compactMap { (raw: Any) -> (email: String, name: String)? in
      guard let d = raw as? [String: Any], let e = d["email"] as? String, !e.isEmpty else { return nil }
      return (email: e, name: (d["name"] as? String) ?? e)
    }
    musicCatalog = ((o["musicCatalog"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any]).map { SSTrack($0) } }.filter { !$0.title.isEmpty }
    if let m = o["music"] as? [String: Any], let t = m["title"] as? String, !t.isEmpty { music = m } else { music = nil }
    let a = (o["audience"] as? String) ?? "all"
    audience = ["all", "contacts", "close_friends", "except"].contains(a) ? a : "all"
    closeFriendsCount = Int(SSOptions.num(o["closeFriendsCount"]) ?? -1)
    exceptCount = Int(SSOptions.num(o["exceptCount"]) ?? 0)
    canCamera = (o["canCamera"] as? Bool) ?? false
    canGallery = (o["canGallery"] as? Bool) ?? true
  }

  func t(_ k: String, _ fb: String) -> String {
    if let s = labels[k], !s.isEmpty { return s }
    return fb
  }

  static func num(_ v: Any?) -> Double? {
    var d: Double?
    if let n = v as? NSNumber { d = n.doubleValue } else if let s = v as? String { d = Double(s) }
    // NaN/infinito/gigante viraria crash em Int(...)
    guard let x = d, x.isFinite, abs(x) < 1e12 else { return nil }
    return x
  }

  static let defaultEmojis: [String] = [
    "\u{1F602}", "\u{1F60D}", "\u{1F970}", "\u{1F60E}", "\u{1F929}", "\u{1F973}", "\u{1F62D}", "\u{1F631}",
    "\u{1F525}", "\u{2764}\u{FE0F}", "\u{1F496}", "\u{2728}", "\u{1F389}", "\u{1F44F}", "\u{1F64C}", "\u{1F44D}",
    "\u{1F4AF}", "\u{1F31F}", "\u{1F308}", "\u{2600}\u{FE0F}", "\u{1F319}", "\u{1F338}", "\u{1F33A}", "\u{1F340}",
    "\u{1F355}", "\u{1F354}", "\u{2615}", "\u{1F37B}", "\u{1F3B6}", "\u{1F3A7}", "\u{1F4F8}", "\u{2708}\u{FE0F}",
  ]
}

extension UIColor {
  static func ss_hex(_ s: String?) -> UIColor? {
    guard var h = s?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty else { return nil }
    if h.hasPrefix("#") { h.removeFirst() }
    if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
    guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
    if h.count == 6 {
      return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                     blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    return UIColor(red: CGFloat((v >> 24) & 0xff) / 255, green: CGFloat((v >> 16) & 0xff) / 255,
                   blue: CGFloat((v >> 8) & 0xff) / 255, alpha: CGFloat(v & 0xff) / 255)
  }

  var ss_hexString: String {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    getRed(&r, green: &g, blue: &b, alpha: &a)
    let c = { (x: CGFloat) -> Int in Int((max(0, min(1, x)) * 255).rounded()) }
    return String(format: "#%02X%02X%02X", c(r), c(g), c(b))
  }
}
