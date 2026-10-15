import ExpoModulesCore
import UIKit
import AVFoundation
import Photos

// [2026-10-15 native-attach] Folha de anexos + câmera do chat em NATIVO
// (nível Telegram/WhatsApp), estética P&B do app (SF Symbols, sem emoji).
//
//   openSheet(options)  → Promise<result>  (AttachSheetController)
//   openCamera(options) → Promise<result>  (ChatCameraController)
//   prewarmCamera() / releaseCamera()      (AVCaptureSession pré-configurada)
//
// Resultados (sempre UM por chamada; nunca rejeita depois de apresentar):
//   { action: 'send',    items, caption, hd, asFile }   (folha: Enviar)
//   { action: 'preview', items }                         (folha: toque longo)
//   { action: 'action',  key }                           (folha: botão/tile câmera)
//   { action: 'capture', items }                         (câmera: foto/vídeo)
//   { action: 'pick',    items }                         (câmera: faixa recentes)
//   { action: 'gallery' }                                (câmera: botão galeria)
//   { action: 'cancel' }
// items[i] = { uri: file://, name, type (mime), size, width, height,
//              duration (s | null), mediaType: 'image' | 'video' }
// Apresentação falhou (sem view controller) → resolve null → JS usa o fallback.
public class ChatyyAttachModule: Module {
  private var sheet: AttachSheetController?
  private var camera: ChatCameraController?

  public func definition() -> ModuleDefinition {
    Name("ChatyyAttach")

    Function("apiVersion") { () -> Int in
      return 1
    }

    Function("isCameraSupported") { () -> Bool in
      return AVCaptureDevice.default(for: .video) != nil
    }

    // Configura a sessão (entradas/saídas) sem rodar: abrir a câmera depois só
    // custa o startRunning. Nunca dispara o prompt de permissão.
    AsyncFunction("prewarmCamera") { () -> Bool in
      CAEngine.shared.prewarm()
      return CAEngine.authorized
    }

    AsyncFunction("releaseCamera") { () -> Bool in
      if self.sheet == nil && self.camera == nil {
        CAEngine.shared.teardownIfIdle()
      }
      return true
    }

    AsyncFunction("openSheet") { (options: [String: Any], promise: Promise) in
      if let old = self.sheet {
        self.sheet = nil
        old.finishSilently()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(nil)
        return
      }
      let cfg = AttachConfig(options)
      let vc = AttachSheetController(config: cfg)
      var done = false
      vc.onFinish = { [weak self] result in
        if done { return }
        done = true
        if self?.sheet === vc { self?.sheet = nil }
        promise.resolve(result)
      }
      self.sheet = vc
      vc.modalPresentationStyle = .overFullScreen
      vc.modalPresentationCapturesStatusBarAppearance = false
      presenter.present(vc, animated: false, completion: nil)
    }.runOnQueue(.main)

    AsyncFunction("openCamera") { (options: [String: Any], promise: Promise) in
      if let old = self.camera {
        self.camera = nil
        old.finishSilently()
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(nil)
        return
      }
      let cfg = AttachConfig(options)
      let vc = ChatCameraController(config: cfg)
      var done = false
      vc.onFinish = { [weak self] result in
        if done { return }
        done = true
        if self?.camera === vc { self?.camera = nil }
        promise.resolve(result)
      }
      self.camera = vc
      vc.modalPresentationStyle = .fullScreen
      vc.modalTransitionStyle = .coverVertical
      presenter.present(vc, animated: true, completion: nil)
    }.runOnQueue(.main)

    // Fecha o que estiver aberto (resolve 'cancel').
    AsyncFunction("dismiss") { () -> Bool in
      var any = false
      if let s = self.sheet { s.closeFromJS(); any = true }
      if let c = self.camera { c.closeFromJS(); any = true }
      return any
    }.runOnQueue(.main)
  }
}

// MARK: - Config / tema

struct AttachAction {
  let key: String
  let label: String
}

struct AttachConfig {
  let labels: [String: String]
  let actions: [AttachAction]
  let dark: Bool
  let bg: UIColor
  let surface: UIColor
  let text: UIColor
  let textSecondary: UIColor
  let border: UIColor
  let chip: UIColor
  let maxSelect: Int
  let hdDefault: Bool
  let allowCamera: Bool
  let maxVideoSec: Double
  let withAudio: Bool

  init(_ o: [String: Any]) {
    var l: [String: String] = [:]
    if let raw = o["labels"] as? [String: Any] {
      for (k, v) in raw { if let s = v as? String { l[k] = s } }
    }
    labels = l
    var acts: [AttachAction] = []
    if let raw = o["actions"] as? [[String: Any]] {
      for a in raw {
        guard let k = a["key"] as? String, !k.isEmpty else { continue }
        acts.append(AttachAction(key: k, label: (a["label"] as? String) ?? k))
      }
    }
    actions = acts
    let d = (o["dark"] as? Bool) ?? (UITraitCollection.current.userInterfaceStyle == .dark)
    dark = d
    let c = o["colors"] as? [String: Any] ?? [:]
    bg = UIColor.ca_hex(c["bg"] as? String) ?? (d ? UIColor(white: 0.07, alpha: 1) : .white)
    surface = UIColor.ca_hex(c["surface"] as? String) ?? (d ? UIColor(white: 0.11, alpha: 1) : UIColor(white: 0.96, alpha: 1))
    text = UIColor.ca_hex(c["text"] as? String) ?? (d ? .white : UIColor(white: 0.07, alpha: 1))
    textSecondary = UIColor.ca_hex(c["textSecondary"] as? String) ?? (d ? UIColor(white: 0.62, alpha: 1) : UIColor(white: 0.42, alpha: 1))
    border = UIColor.ca_hex(c["border"] as? String) ?? (d ? UIColor(white: 1, alpha: 0.10) : UIColor(white: 0, alpha: 0.08))
    chip = UIColor.ca_hex(c["chip"] as? String) ?? (d ? UIColor(red: 0.17, green: 0.17, blue: 0.18, alpha: 1) : UIColor(red: 0.95, green: 0.95, blue: 0.96, alpha: 1))
    maxSelect = max(1, AttachConfig.int(o["maxSelect"]) ?? 30)
    hdDefault = (o["hdDefault"] as? Bool) ?? false
    allowCamera = (o["allowCamera"] as? Bool) ?? true
    maxVideoSec = max(3, AttachConfig.double(o["maxVideoSec"]) ?? 60)
    withAudio = (o["withAudio"] as? Bool) ?? true
  }

  func t(_ key: String, _ fallback: String) -> String {
    if let v = labels[key], !v.isEmpty { return v }
    return fallback
  }

  static func int(_ v: Any?) -> Int? {
    if let n = v as? NSNumber { return n.intValue }
    if let s = v as? String { return Int(s) }
    return nil
  }

  static func double(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    if let s = v as? String { return Double(s) }
    return nil
  }
}

extension UIColor {
  static func ca_hex(_ s: String?) -> UIColor? {
    guard var h = s?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty else { return nil }
    if h.hasPrefix("#") { h.removeFirst() }
    guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return nil }
    if h.count == 6 {
      return UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                     blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    return UIColor(red: CGFloat((v >> 24) & 0xff) / 255, green: CGFloat((v >> 16) & 0xff) / 255,
                   blue: CGFloat((v >> 8) & 0xff) / 255, alpha: CGFloat(v & 0xff) / 255)
  }
}

enum CAFormat {
  static func duration(_ sec: Double) -> String {
    let s = max(0, Int(sec.rounded()))
    return String(format: "%d:%02d", s / 60, s % 60)
  }

  static func symbol(_ name: String, _ size: CGFloat, _ weight: UIImage.SymbolWeight = .regular) -> UIImage? {
    let cfg = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    return UIImage(systemName: name, withConfiguration: cfg)
  }

  /// SF Symbol por chave de ação (mesmas chaves do buildAttachItems do JS).
  static func symbolName(forAction key: String) -> String? {
    switch key {
    case "camera": return "camera"
    case "gallery": return "photo.on.rectangle"
    case "file": return "doc"
    case "scan_document": return "doc.viewfinder"
    case "location", "liveLocation": return "location"
    case "contact": return "person.crop.circle"
    case "poll": return "chart.bar"
    case "meetup": return "calendar"
    case "playlist", "audio", "music": return "music.note"
    case "gift": return "gift"
    case "short_video": return "film"
    case "gif": return nil // desenhado como texto "GIF"
    default: return "square.grid.2x2"
    }
  }
}

func caHaptic(_ kind: String) {
  switch kind {
  case "select":
    let g = UISelectionFeedbackGenerator(); g.selectionChanged()
  case "warn":
    let g = UINotificationFeedbackGenerator(); g.notificationOccurred(.warning)
  case "heavy":
    let g = UIImpactFeedbackGenerator(style: .medium); g.impactOccurred()
  default:
    let g = UIImpactFeedbackGenerator(style: .light); g.impactOccurred()
  }
}
