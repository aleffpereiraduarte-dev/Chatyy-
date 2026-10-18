// ChatyyNativeShare.swift — compartilhar 100% NATIVO (estilo WhatsApp) na
// ShareExtension do iOS. [2026-10-18 native-share]
//
// COMO É EMBARCADO
//   plugins/with-custom-share-extension.js (mod FINALIZED, depois do xcodeproj
//   do expo-share-intent) pega o ShareViewController.swift do template do
//   expo-share-intent, renomeia a classe para ChatyyShareIntentFallbackController
//   (o fluxo antigo: copia p/ o App Group e abre o app em /share-receive) e
//   ANEXA este arquivo no mesmo .swift (o target só compila esse arquivo).
//   Aqui `ShareViewController` (a classe do storyboard) é SUBCLASSE do template:
//   o fallback continua inteiro e é só chamar chatyyStartLegacyFlow().
//
// QUANDO VAI NATIVO (senão: fallback = abre o app como hoje)
//   • Info.plist da extensão ChatyyNativeShare = YES (plugin; CHATYY_NATIVE_SHARE=0 desliga)
//   • App Group chatyy.share.native_enabled == true (JS; __chatyy_native_share === false grava false)
//   • sem bloqueio do app (Face ID) — chatyy.widget_locked
//   • token + conta + snapshot das conversas (chatyy.share.snapshot.v1) da MESMA conta
//   • conteúdo suportado: foto, vídeo, arquivo, link, texto (≤ 10 itens). vCard,
//     pkpass, export do WhatsApp (.zip/_chat.txt) e .wastickers → app.
//   Conversas com E2EE, bloqueadas, trancadas, arquivadas, canais: o JS nem
//   coloca no snapshot (services/nativeShareSnapshot.js).
//
// ENVIO (o mais confiável p/ extensão: ~120 MB e pouco tempo de vida)
//   Cada (item × conversa) vira UM POST que sozinho cria a mensagem no servidor:
//   mídia → email.php?action=chat_upload (multipart: arquivo + legenda +
//   client_message_id; o servidor gera pôster/miniatura e faz push/WS); texto/link
//   → email.php?action=chat_send (JSON). O corpo é gravado em ARQUIVO no App Group
//   e enviado por uma URLSession de SEGUNDO PLANO com sharedContainerIdentifier:
//   o nsurlsessiond continua o upload depois que a extensão fecha, sem precisar
//   do app. Cada envio tem um "job" JSON no App Group (ChatyyShare/jobs). Se a
//   extensão morrer antes do fim, o iOS acorda o app (handleEventsForBackground-
//   URLSession) e modules/expo-chat-transport/ios/ChatyyShareOutbox.swift fecha o
//   job; o que falhou de forma transitória é entregue à fila nativa (ChatOutbox)
//   no próximo boot/volta ao primeiro plano. Dedupe no servidor por
//   (remetente, client_message_id) → reenvio nunca duplica a mensagem.

import UIKit
import Intents
import ImageIO
import UniformTypeIdentifiers
import AVFoundation

// MARK: - Constantes

enum ChatyyShareConst {
  static let appGroup = "group.com.onemundo.mail"
  static let snapshotKey = "chatyy.share.snapshot.v1"
  static let enabledKey = "chatyy.share.native_enabled"
  static let tokenKey = "chatyy.auth_token"
  static let emailKey = "chatyy.auth_email"
  static let baseKey = "chatyy.base_url"
  static let appLockedKey = "chatyy.widget_locked"
  static let shareTargetKey = "chatyy.share_target"
  static let diagKey = "chatyy.share_diag"
  static let lastErrKey = "chatyy.share_last_error"
  static let sessionPrefix = "com.onemundo.mail.shareext."
  static let defaultBase = "https://chatyy.com.br"
  static let maxRecipients = 5
  static let maxItems = 10
  static let maxSends = 30          // chat_upload: 30 uploads/min por usuário
  static let maxBytes: Int64 = 200 * 1024 * 1024
  static let imageMaxPixel = 2560
  static let foregroundWaitSec: Double = 7

  static var containerURL: URL? {
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
  }
  static func dir(_ name: String) -> URL? {
    guard let root = containerURL else { return nil }
    let d = root.appendingPathComponent("ChatyyShare", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }
  static func usableBase(_ raw: String) -> String {
    let b = raw.trimmingCharacters(in: CharacterSet(charactersIn: "/ \n"))
    guard let u = URL(string: b), u.scheme == "https", let h = u.host?.lowercased() else { return defaultBase }
    return (h == "chatyy.com.br" || h.hasSuffix(".chatyy.com.br")) ? b : defaultBase
  }
}

// MARK: - Diagnóstico (mesmo ring-buffer lido por /share-diagnose)

enum ChatyyShareDiag {
  static func log(_ level: String, _ msg: String) {
    guard let ud = UserDefaults(suiteName: ChatyyShareConst.appGroup) else { return }
    let entry: [String: Any] = ["ts": Date().timeIntervalSince1970, "level": level, "msg": "native: " + String(msg.prefix(380))]
    var q = (ud.array(forKey: ChatyyShareConst.diagKey) as? [[String: Any]]) ?? []
    q.append(entry)
    if q.count > 80 { q.removeFirst(q.count - 80) }
    ud.set(q, forKey: ChatyyShareConst.diagKey)
    if level == "error" { ud.set(entry, forKey: ChatyyShareConst.lastErrKey) }
  }
}

// MARK: - Textos (pt-BR padrão; en/es)

enum ChatyyShareL10n {
  static let lang: String = {
    let p = (Locale.preferredLanguages.first ?? "pt").lowercased()
    if p.hasPrefix("pt") { return "pt" }
    if p.hasPrefix("es") { return "es" }
    return "en"
  }()
  static func t(_ pt: String, _ en: String, _ es: String) -> String {
    switch lang { case "pt": return pt; case "es": return es; default: return en }
  }
  static var cancel: String { t("Cancelar", "Cancel", "Cancelar") }
  static var sendTo: String { t("Enviar para", "Send to", "Enviar a") }
  static var search: String { t("Buscar", "Search", "Buscar") }
  static var recents: String { t("CONVERSAS RECENTES", "RECENT CHATS", "CHATS RECIENTES") }
  static var group: String { t("Grupo", "Group", "Grupo") }
  static var caption: String { t("Adicionar legenda…", "Add a caption…", "Añadir un comentario…") }
  static var message: String { t("Mensagem", "Message", "Mensaje") }
  static var to: String { t("Para", "To", "Para") }
  static var sending: String { t("Enviando…", "Sending…", "Enviando…") }
  static var sent: String { t("Enviado", "Sent", "Enviado") }
  static var background: String { t("Continua enviando em segundo plano", "Still sending in the background", "Se sigue enviando en segundo plano") }
  static var openApp: String { t("Mais opções no Chatyy", "More options in Chatyy", "Más opciones en Chatyy") }
  static var noResults: String { t("Nenhuma conversa encontrada", "No chats found", "No se encontraron chats") }
  static var loading: String { t("Preparando…", "Preparing…", "Preparando…") }
  static var icloud: String { t("Baixando do iCloud…", "Downloading from iCloud…", "Descargando de iCloud…") }
  static var tooBig: String { t("Arquivo maior que 200 MB.", "File is larger than 200 MB.", "Archivo mayor de 200 MB.") }
  static var loadFailed: String { t("Não foi possível ler o conteúdo.", "Couldn't read the content.", "No se pudo leer el contenido.") }
  static var maxChats: String { t("Até 5 conversas por vez", "Up to 5 chats at a time", "Hasta 5 chats a la vez") }
  static var tooMany: String { t("Muitos envios de uma vez. Escolha menos conversas.", "Too many sends at once. Pick fewer chats.", "Demasiados envíos a la vez. Elige menos chats.") }
  static var failed: String { t("Não foi possível enviar", "Couldn't send", "No se pudo enviar") }
  static var ok: String { "OK" }
  static var openInApp: String { t("Abrir no Chatyy", "Open in Chatyy", "Abrir en Chatyy") }
  static var video: String { t("Vídeo", "Video", "Video") }
  static var photo: String { t("Foto", "Photo", "Foto") }
  static var file: String { t("Arquivo", "File", "Archivo") }
}

// MARK: - Tema preto e branco (claro/escuro)

enum ChatyyShareTheme {
  static let bg = UIColor { $0.userInterfaceStyle == .dark ? UIColor.black : UIColor.white }
  static let ink = UIColor { $0.userInterfaceStyle == .dark ? UIColor.white : UIColor.black }
  static let inkInverse = UIColor { $0.userInterfaceStyle == .dark ? UIColor.black : UIColor.white }
  static let secondary = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.62, alpha: 1) : UIColor(white: 0.40, alpha: 1) }
  static let hairline = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.14) : UIColor(white: 0, alpha: 0.10) }
  static let fill = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.12, alpha: 1) : UIColor(white: 0.95, alpha: 1) }
  static let stage = UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.06, alpha: 1) : UIColor(white: 0.97, alpha: 1) }

  static func font(_ size: CGFloat, _ weight: UIFont.Weight = .regular) -> UIFont {
    return UIFont.systemFont(ofSize: size, weight: weight)
  }
}

// MARK: - Modelos

struct ChatyyShareConversation {
  let id: String
  let title: String
  let isGroup: Bool
  let email: String
  let avatarFile: String
  let searchKey: String

  var avatarURL: URL? {
    if avatarFile.isEmpty { return nil }
    if avatarFile.hasPrefix("/") { return URL(fileURLWithPath: avatarFile) }
    return ChatyyShareConst.dir("avatars")?.appendingPathComponent(avatarFile)
  }
}

struct ChatyyShareSession {
  let token: String
  let account: String
  let base: String
  let conversations: [ChatyyShareConversation]
}

enum ChatyyShareItemKind: String { case image, video, file, text, link }

final class ChatyyShareItem {
  let kind: ChatyyShareItemKind
  var fileURL: URL?
  var mime: String = "application/octet-stream"
  var fileName: String = "file"
  var size: Int64 = 0
  var text: String = ""
  var thumb: UIImage?
  var duration: Double = 0
  init(kind: ChatyyShareItemKind) { self.kind = kind }
  var isMedia: Bool { return kind == .image || kind == .video || kind == .file }
}

// MARK: - Portão: nativo ou fallback

enum ChatyyShareGate {
  static func session() -> ChatyyShareSession? {
    let flag = Bundle.main.object(forInfoDictionaryKey: "ChatyyNativeShare")
    let on = (flag as? Bool) ?? ((flag as? String).map { $0 == "1" || $0.uppercased() == "YES" || $0.lowercased() == "true" } ?? false)
    if !on { return nil }
    guard let ud = UserDefaults(suiteName: ChatyyShareConst.appGroup) else { return nil }
    guard ud.object(forKey: ChatyyShareConst.enabledKey) != nil, ud.bool(forKey: ChatyyShareConst.enabledKey) else {
      ChatyyShareDiag.log("info", "gate: kill switch / flag ausente → app")
      return nil
    }
    if ud.bool(forKey: ChatyyShareConst.appLockedKey) {
      ChatyyShareDiag.log("info", "gate: bloqueio do app ligado → app")
      return nil
    }
    let token = ud.string(forKey: ChatyyShareConst.tokenKey) ?? ""
    let account = (ud.string(forKey: ChatyyShareConst.emailKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if token.isEmpty || account.isEmpty {
      ChatyyShareDiag.log("info", "gate: sem token/conta → app")
      return nil
    }
    guard let data = ud.data(forKey: ChatyyShareConst.snapshotKey),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let rows = obj["items"] as? [[String: Any]] else {
      ChatyyShareDiag.log("info", "gate: sem snapshot → app")
      return nil
    }
    if (obj["locked"] as? Bool) == true {
      ChatyyShareDiag.log("info", "gate: bloqueio do app (snapshot) → app")
      return nil
    }
    let acct = ((obj["acct"] as? String) ?? "").lowercased()
    if acct != account {
      ChatyyShareDiag.log("info", "gate: snapshot de outra conta → app")
      return nil
    }
    var convs: [ChatyyShareConversation] = []
    for r in rows {
      let id = str(r["id"])
      let title = str(r["title"])
      if id.isEmpty || title.isEmpty { continue }
      let email = str(r["email"]).lowercased()
      let key = (title + " " + email).folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
      convs.append(ChatyyShareConversation(id: id, title: title, isGroup: (r["is_group"] as? Bool) ?? false,
                                           email: email, avatarFile: str(r["avatar"]), searchKey: key))
    }
    if convs.isEmpty {
      ChatyyShareDiag.log("info", "gate: snapshot vazio → app")
      return nil
    }
    let base = ChatyyShareConst.usableBase(ud.string(forKey: ChatyyShareConst.baseKey) ?? "")
    return ChatyyShareSession(token: token, account: account, base: base, conversations: convs)
  }

  /// Só o que o envio nativo sabe tratar; o resto (vCard, pkpass, import do WhatsApp…) vai ao app.
  static func contentSupported(_ ctx: NSExtensionContext?) -> Bool {
    let providers = attachments(ctx)
    if providers.isEmpty || providers.count > ChatyyShareConst.maxItems { return false }
    for p in providers {
      if p.hasItemConformingToTypeIdentifier("public.vcard") || p.hasItemConformingToTypeIdentifier("com.apple.pkpass") { return false }
      let name = (p.suggestedName ?? "").lowercased()
      if name.hasSuffix(".wastickers") { return false }
      if (name.hasSuffix(".zip") || name.hasSuffix(".txt")) && (name.contains("whatsapp") || name.contains("_chat")) { return false }
      if classify(p) == nil { return false }
    }
    return true
  }

  static func attachments(_ ctx: NSExtensionContext?) -> [NSItemProvider] {
    var out: [NSItemProvider] = []
    for case let item as NSExtensionItem in (ctx?.inputItems ?? []) {
      for p in item.attachments ?? [] { out.append(p) }
    }
    return out
  }

  enum Source { case image, movie, propertyList, url, text, data }

  static func classify(_ p: NSItemProvider) -> Source? {
    if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) { return .image }
    if p.hasItemConformingToTypeIdentifier(UTType.movie.identifier) { return .movie }
    if p.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) { return .propertyList }
    if p.hasItemConformingToTypeIdentifier(UTType.url.identifier) { return .url }
    if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) || p.hasItemConformingToTypeIdentifier(UTType.text.identifier) { return .text }
    if p.hasItemConformingToTypeIdentifier(UTType.data.identifier) || p.hasItemConformingToTypeIdentifier(UTType.content.identifier) { return .data }
    return nil
  }

  /// Sugestão tocada no topo da folha de compartilhar (INSendMessageIntent, conversationIdentifier "chat_<id>").
  static func preselectedId(_ ctx: NSExtensionContext?, in convs: [ChatyyShareConversation]) -> String? {
    guard let intent = ctx?.intent as? INSendMessageIntent else { return nil }
    if var cid = intent.conversationIdentifier, !cid.isEmpty {
      if cid.hasPrefix("chat_") { cid = String(cid.dropFirst(5)) }
      if convs.contains(where: { $0.id == cid }) { return cid }
    }
    for person in intent.recipients ?? [] {
      if let custom = person.customIdentifier, convs.contains(where: { $0.id == custom }) { return custom }
      let handle = (person.personHandle?.value ?? "").lowercased()
      if handle.isEmpty { continue }
      if handle.hasPrefix("group_") {
        let gid = String(handle.dropFirst(6))
        if convs.contains(where: { $0.id == gid }) { return gid }
      }
      if let m = convs.first(where: { !$0.isGroup && $0.email == handle }) { return m.id }
    }
    return nil
  }

  static func str(_ v: Any?) -> String {
    if v == nil || v is NSNull { return "" }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return ""
  }
}

// MARK: - Leitura do conteúdo compartilhado → arquivos no App Group

final class ChatyyShareLoader {
  let batchDir: URL
  private let lock = NSLock()
  private var results: [Int: ChatyyShareItem] = [:]
  private var errors: [String] = []
  private(set) var progresses: [Progress] = []
  /// Decodificar/reduzir foto e gerar miniatura de vídeo UM POR VEZ: 10 fotos
  /// em paralelo estourariam os ~120 MB da extensão.
  private let work = DispatchQueue(label: "chatyy.share.loader")

  init?(batch: String) {
    guard let d = ChatyyShareConst.dir("staging")?.appendingPathComponent(batch, isDirectory: true) else { return nil }
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    batchDir = d
  }

  func load(_ providers: [NSItemProvider], done: @escaping ([ChatyyShareItem], [String]) -> Void) {
    let group = DispatchGroup()
    for (i, p) in providers.enumerated() {
      guard let src = ChatyyShareGate.classify(p) else { continue }
      group.enter()
      let finish: (ChatyyShareItem?, String?) -> Void = { [weak self] item, err in
        guard let self = self else { group.leave(); return }
        self.lock.lock()
        if let item = item { self.results[i] = item }
        if let err = err { self.errors.append(err) }
        self.lock.unlock()
        group.leave()
      }
      switch src {
      case .image: loadImage(p, i, finish)
      case .movie: loadVideo(p, i, finish)
      case .propertyList: loadPropertyList(p, finish)
      case .url: loadURL(p, i, finish)
      case .text: loadText(p, finish)
      case .data: loadData(p, i, finish)
      }
    }
    group.notify(queue: .main) { [weak self] in
      guard let self = self else { return }
      self.lock.lock()
      let items = self.results.keys.sorted().compactMap { self.results[$0] }
      let errs = self.errors
      self.lock.unlock()
      done(items, errs)
    }
  }

  private func track(_ p: Progress?) {
    guard let p = p else { return }
    lock.lock(); progresses.append(p); lock.unlock()
  }

  var fractionCompleted: Double {
    lock.lock(); defer { lock.unlock() }
    if progresses.isEmpty { return 0 }
    return progresses.map { $0.fractionCompleted }.reduce(0, +) / Double(progresses.count)
  }

  private func dest(_ i: Int, _ ext: String) -> URL {
    let e = ext.isEmpty ? "bin" : ext.lowercased()
    return batchDir.appendingPathComponent("item\(i).\(e)")
  }

  static func fileSize(_ u: URL) -> Int64 {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: u.path),
          let n = attrs[.size] as? NSNumber else { return 0 }
    return n.int64Value
  }

  private static func mime(forExt ext: String) -> String {
    return UTType(filenameExtension: ext.lowercased())?.preferredMIMEType ?? "application/octet-stream"
  }

  private func copyIn(_ src: URL, _ dst: URL) -> Bool {
    try? FileManager.default.removeItem(at: dst)
    do { try FileManager.default.copyItem(at: src, to: dst); return true } catch {
      ChatyyShareDiag.log("warn", "copy failed: \(error.localizedDescription)")
      return false
    }
  }

  // Foto → JPEG ≤ 2560 px (HEIC/PNG enormes viram algo que qualquer aparelho abre).
  // GIF fica como está (animação).
  private func loadImage(_ p: NSItemProvider, _ i: Int, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    let isGif = p.hasItemConformingToTypeIdentifier(UTType.gif.identifier)
    let prog = p.loadFileRepresentation(forTypeIdentifier: isGif ? UTType.gif.identifier : UTType.image.identifier) { [weak self] url, err in
      guard let self = self else { finish(nil, nil); return }
      // o arquivo só vale dentro deste callback: copia já, processa na fila serial
      if let url = url {
        var ext = url.pathExtension.lowercased(); if ext.isEmpty { ext = isGif ? "gif" : "img" }
        let raw = self.dest(i, "src." + ext)
        if self.copyIn(url, raw) {
          self.work.async {
            let item = self.processImage(at: raw, i, isGif: isGif, name: p.suggestedName)
            try? FileManager.default.removeItem(at: raw)
            finish(item, item == nil ? "image: decode" : nil)
          }
          return
        }
      }
      // Capturas de tela / apps que só entregam UIImage ou Data
      p.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { obj, err2 in
        let tmp = self.dest(i, "src")
        var ok = false
        if let u = obj as? URL { ok = self.copyIn(u, tmp) }
        else if let d = obj as? Data { ok = (try? d.write(to: tmp)) != nil }
        else if let img = obj as? UIImage, let d = img.jpegData(compressionQuality: 0.85) { ok = (try? d.write(to: tmp)) != nil }
        if !ok { finish(nil, "image: \((err ?? err2)?.localizedDescription ?? "unreadable")"); return }
        self.work.async {
          let item = self.processImage(at: tmp, i, isGif: false, name: p.suggestedName)
          try? FileManager.default.removeItem(at: tmp)
          finish(item, item == nil ? "image: decode" : nil)
        }
      }
    }
    track(prog)
  }

  private func processImage(at src: URL, _ i: Int, isGif: Bool, name: String?) -> ChatyyShareItem? {
    let item = ChatyyShareItem(kind: .image)
    let base = ((name ?? "").isEmpty ? "IMG_\(Int(Date().timeIntervalSince1970))_\(i)" : (name! as NSString).deletingPathExtension)
    if isGif {
      let dst = dest(i, "gif")
      guard copyIn(src, dst) else { return nil }
      item.fileURL = dst; item.mime = "image/gif"; item.fileName = base + ".gif"
    } else {
      let dst = dest(i, "jpg")
      guard let source = CGImageSourceCreateWithURL(src as CFURL, nil) else { return nil }
      let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: ChatyyShareConst.imageMaxPixel,
      ]
      guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary),
            let out = CGImageDestinationCreateWithURL(dst as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
      CGImageDestinationAddImage(out, cg, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
      guard CGImageDestinationFinalize(out) else { return nil }
      item.fileURL = dst; item.mime = "image/jpeg"; item.fileName = base + ".jpg"
    }
    item.size = Self.fileSize(item.fileURL!)
    item.thumb = Self.thumbnail(item.fileURL!, maxPixel: 900)
    return item
  }

  static func thumbnail(_ url: URL, maxPixel: Int) -> UIImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ]
    guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
    return UIImage(cgImage: cg)
  }

  private func loadVideo(_ p: NSItemProvider, _ i: Int, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    let prog = p.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { [weak self] url, err in
      guard let self = self, let url = url else { finish(nil, "video: \(err?.localizedDescription ?? "unreadable")"); return }
      let size = Self.fileSize(url)
      if size > ChatyyShareConst.maxBytes { finish(nil, "too_big"); return }
      var ext = url.pathExtension.lowercased(); if ext.isEmpty { ext = "mov" }
      let dst = self.dest(i, ext)
      guard self.copyIn(url, dst) else { finish(nil, "video: copy"); return }
      self.work.async { finish(self.makeVideo(dst, size: size, ext: ext, name: p.suggestedName, i), nil) }
    }
    track(prog)
  }

  private func makeVideo(_ dst: URL, size: Int64, ext: String, name: String?, _ i: Int) -> ChatyyShareItem {
      let item = ChatyyShareItem(kind: .video)
      item.fileURL = dst
      item.size = size
      item.mime = ext == "mp4" ? "video/mp4" : (ext == "m4v" ? "video/x-m4v" : Self.mime(forExt: ext))
      if item.mime == "application/octet-stream" { item.mime = "video/quicktime" }
      let n = name ?? ""
      item.fileName = (n.isEmpty ? "VID_\(Int(Date().timeIntervalSince1970))_\(i)" : (n as NSString).deletingPathExtension) + "." + ext
      let asset = AVURLAsset(url: dst)
      item.duration = CMTimeGetSeconds(asset.duration)
      let gen = AVAssetImageGenerator(asset: asset)
      gen.appliesPreferredTrackTransform = true
      gen.maximumSize = CGSize(width: 900, height: 900)
      if let cg = try? gen.copyCGImage(at: CMTime(seconds: 0.1, preferredTimescale: 600), actualTime: nil) {
        item.thumb = UIImage(cgImage: cg)
      }
      return item
  }

  // Safari com o pré-processador JS do expo-share-intent → baseURI
  private func loadPropertyList(_ p: NSItemProvider, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    p.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { obj, err in
      let dict = obj as? NSDictionary
      let res = dict?[NSExtensionJavaScriptPreprocessingResultsKey] as? NSDictionary
      let link = (res?["baseURI"] as? String) ?? ""
      if link.isEmpty { finish(nil, "plist: \(err?.localizedDescription ?? "empty")"); return }
      let item = ChatyyShareItem(kind: .link)
      item.text = link
      finish(item, nil)
    }
  }

  private func loadURL(_ p: NSItemProvider, _ i: Int, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    p.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [weak self] obj, err in
      guard let self = self else { finish(nil, nil); return }
      var url: URL? = obj as? URL
      if url == nil, let d = obj as? Data { url = URL(dataRepresentation: d, relativeTo: nil) }
      if url == nil, let s = obj as? String { url = URL(string: s) }
      guard let u = url else { finish(nil, "url: \(err?.localizedDescription ?? "empty")"); return }
      if u.isFileURL {
        self.consumeFile(u, i, name: p.suggestedName, finish)
        return
      }
      let item = ChatyyShareItem(kind: .link)
      item.text = u.absoluteString
      finish(item, nil)
    }
  }

  private func loadText(_ p: NSItemProvider, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    let tid = p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) ? UTType.plainText.identifier : UTType.text.identifier
    p.loadItem(forTypeIdentifier: tid, options: nil) { obj, err in
      var s = ""
      if let t = obj as? String { s = t }
      else if let a = obj as? NSAttributedString { s = a.string }
      else if let d = obj as? Data { s = String(data: d, encoding: .utf8) ?? "" }
      else if let u = obj as? URL, !u.isFileURL { s = u.absoluteString }
      s = s.trimmingCharacters(in: .whitespacesAndNewlines)
      if s.isEmpty { finish(nil, "text: \(err?.localizedDescription ?? "empty")"); return }
      let item = ChatyyShareItem(kind: .text)
      item.text = s
      finish(item, nil)
    }
  }

  private func loadData(_ p: NSItemProvider, _ i: Int, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    let tid = p.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) ?? false }) ?? UTType.data.identifier
    let prog = p.loadFileRepresentation(forTypeIdentifier: tid) { [weak self] url, err in
      guard let self = self, let url = url else { finish(nil, "file: \(err?.localizedDescription ?? "unreadable")"); return }
      self.consumeFile(url, i, name: p.suggestedName, finish)
    }
    track(prog)
  }

  private func consumeFile(_ url: URL, _ i: Int, name: String?, _ finish: @escaping (ChatyyShareItem?, String?) -> Void) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let size = Self.fileSize(url)
    if size > ChatyyShareConst.maxBytes { finish(nil, "too_big"); return }
    var fname = url.lastPathComponent
    if let n = name, !n.isEmpty { fname = (n as NSString).pathExtension.isEmpty && !url.pathExtension.isEmpty ? n + "." + url.pathExtension : n }
    let ext = (fname as NSString).pathExtension.lowercased()
    let type = UTType(filenameExtension: ext)
    if let t = type, t.conforms(to: .image), ext != "svg" {
      let gif = t.conforms(to: .gif)
      let raw = dest(i, "src." + ext)
      guard copyIn(url, raw) else { finish(nil, "file: copy"); return }
      work.async {
        if let item = self.processImage(at: raw, i, isGif: gif, name: fname) {
          try? FileManager.default.removeItem(at: raw)
          finish(item, nil)
        } else {
          finish(self.plainFile(raw, size: size, ext: ext, name: fname), nil)
        }
      }
      return
    }
    let dst = dest(i, ext)
    guard copyIn(url, dst) else { finish(nil, "file: copy"); return }
    if type?.conforms(to: .movie) ?? false {
      work.async { finish(self.makeVideo(dst, size: size, ext: ext, name: fname, i), nil) }
      return
    }
    finish(plainFile(dst, size: size, ext: ext, name: fname), nil)
  }

  private func plainFile(_ dst: URL, size: Int64, ext: String, name: String) -> ChatyyShareItem {
    let item = ChatyyShareItem(kind: .file)
    item.fileURL = dst
    item.size = size
    item.mime = Self.mime(forExt: ext)
    item.fileName = name.isEmpty ? "file.\(ext.isEmpty ? "bin" : ext)" : name
    return item
  }
}

// MARK: - Envio: jobs no App Group + URLSession de 2º plano

final class ChatyyShareSender: NSObject, URLSessionDataDelegate {
  struct Job {
    let cmi: String
    let conv: String
    let kind: String      // "media" | "text"
    let msgType: String   // image | video | file | text
    let file: String      // caminho absoluto da mídia preparada (App Group)
    let mime: String
    let fileName: String
    let caption: String
  }

  let session: ChatyyShareSession
  let sessionId: String
  private var urlSession: URLSession!
  private let lock = NSLock()
  private var pending = Set<String>()
  private var okCount = 0
  private var failures: [String] = []
  private var received: [Int: Data] = [:]
  private var bytesSent: [Int: Int64] = [:]
  private var bytesTotal: [Int: Int64] = [:]
  var onProgress: ((Double) -> Void)?
  var onFinish: ((Int, [String]) -> Void)?
  private(set) var startedCount = 0

  init(session: ChatyyShareSession) {
    self.session = session
    self.sessionId = ChatyyShareConst.sessionPrefix + UUID().uuidString
    super.init()
    let cfg = URLSessionConfiguration.background(withIdentifier: sessionId)
    cfg.sharedContainerIdentifier = ChatyyShareConst.appGroup
    cfg.isDiscretionary = false
    cfg.sessionSendsLaunchEvents = true
    cfg.allowsCellularAccess = true
    cfg.timeoutIntervalForResource = 24 * 3600
    urlSession = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
  }

  static func newCmi() -> String {
    return "share-" + UUID().uuidString.lowercased()
  }

  /// Monta e dispara. false = nada pôde ser enfileirado (o chamador mostra erro / cai no app).
  func send(jobs: [Job]) -> Bool {
    guard let jobsDir = ChatyyShareConst.dir("jobs"), let bodiesDir = ChatyyShareConst.dir("bodies") else { return false }
    var tasks: [URLSessionUploadTask] = []
    for job in jobs {
      let bodyURL = bodiesDir.appendingPathComponent(job.cmi + ".body")
      var req: URLRequest
      if job.kind == "media" {
        guard let u = URL(string: session.base + "/api/email.php?action=chat_upload") else { continue }
        req = URLRequest(url: u)
        let boundary = "chatyy-share-" + UUID().uuidString
        var fields: [(String, String)] = [
          ("action", "chat_upload"),
          ("conversation_id", job.conv),
          ("client_message_id", job.cmi),
          ("type", job.msgType),
        ]
        if !job.caption.isEmpty { fields.append(("content", job.caption)) }
        guard Self.writeMultipart(to: bodyURL, boundary: boundary, fields: fields,
                                  fileURL: URL(fileURLWithPath: job.file), fileName: job.fileName, mime: job.mime) else {
          ChatyyShareDiag.log("error", "multipart write failed cmi=\(job.cmi)")
          continue
        }
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
      } else {
        guard let u = URL(string: session.base + "/api/email.php?action=chat_send") else { continue }
        req = URLRequest(url: u)
        var convValue: Any = job.conv
        if let n = Int(job.conv) { convValue = NSNumber(value: n) }
        let body: [String: Any] = [
          "conversation_id": convValue,
          "content": job.caption,
          "type": "text",
          "client_message_id": job.cmi,
        ]
        guard let d = try? JSONSerialization.data(withJSONObject: body), (try? d.write(to: bodyURL)) != nil else { continue }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      req.httpMethod = "POST"
      req.setValue("Bearer " + session.token, forHTTPHeaderField: "Authorization")
      req.setValue("share-extension", forHTTPHeaderField: "X-Chatyy-Client")
      // job durável ANTES de disparar (o app conclui/reenvia se a extensão morrer)
      let manifest: [String: Any] = [
        "v": 1, "cmi": job.cmi, "conv": job.conv, "kind": job.kind, "msg_type": job.msgType,
        "file": job.file, "mime": job.mime, "file_name": job.fileName, "caption": job.caption,
        "account": session.account, "session": sessionId, "body": bodyURL.path,
        "state": "pending", "created_at": Date().timeIntervalSince1970 * 1000, "tries": 1,
      ]
      guard let md = try? JSONSerialization.data(withJSONObject: manifest),
            (try? md.write(to: jobsDir.appendingPathComponent(job.cmi + ".json"), options: .atomic)) != nil else { continue }
      let task = urlSession.uploadTask(with: req, fromFile: bodyURL)
      task.taskDescription = job.cmi
      tasks.append(task)
    }
    // todos no `pending` ANTES do 1º resume (um texto rápido não fecha o lote cedo)
    lock.lock(); for t in tasks { if let c = t.taskDescription { pending.insert(c) } }; lock.unlock()
    let started = tasks.count
    startedCount = started
    for t in tasks { t.resume() }
    ChatyyShareDiag.log("info", "send: \(started)/\(jobs.count) job(s) session=\(sessionId.suffix(8))")
    if started == 0 { urlSession.invalidateAndCancel() }
    return started > 0
  }

  static func writeMultipart(to body: URL, boundary: String, fields: [(String, String)], fileURL: URL, fileName: String, mime: String) -> Bool {
    FileManager.default.createFile(atPath: body.path, contents: nil)
    guard let out = try? FileHandle(forWritingTo: body), let src = FileHandle(forReadingAtPath: fileURL.path) else { return false }
    func w(_ s: String) { if let d = s.data(using: .utf8) { out.write(d) } }
    for (k, v) in fields {
      w("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
    }
    let safeName = fileName.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
    w("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n")
    while true {
      let chunk = src.readData(ofLength: 1 << 20)
      if chunk.isEmpty { break }
      out.write(chunk)
    }
    src.closeFile()
    w("\r\n--\(boundary)--\r\n")
    out.closeFile()
    return true
  }

  // MARK: URLSession delegate (fila própria da sessão)

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock(); received[dataTask.taskIdentifier, default: Data()].append(data); lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    lock.lock()
    self.bytesSent[task.taskIdentifier] = totalBytesSent
    if totalBytesExpectedToSend > 0 { bytesTotal[task.taskIdentifier] = totalBytesExpectedToSend }
    let sent = self.bytesSent.values.reduce(0, +)
    let total = bytesTotal.values.reduce(0, +)
    lock.unlock()
    if total > 0 {
      let f = min(1.0, Double(sent) / Double(total))
      DispatchQueue.main.async { self.onProgress?(f) }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let cmi = task.taskDescription else { return }
    lock.lock()
    let data = received.removeValue(forKey: task.taskIdentifier) ?? Data()
    lock.unlock()
    let code = error == nil ? ((task.response as? HTTPURLResponse)?.statusCode ?? 0) : 0
    let outcome = ChatyyShareJobs.outcome(code: code, data: data, error: error)
    ChatyyShareJobs.update(cmi: cmi, outcome: outcome)
    lock.lock()
    pending.remove(cmi)
    if outcome.state == "sent" { okCount += 1 } else if outcome.state == "failed" { failures.append(outcome.message) }
    let left = pending.count
    let ok = okCount
    let fails = failures
    lock.unlock()
    if left == 0 {
      DispatchQueue.main.async { self.onFinish?(ok, fails) }
    }
  }
}

/// Estado dos jobs no App Group (a extensão e o app usam o mesmo formato).
enum ChatyyShareJobs {
  struct Outcome { let state: String; let message: String }

  static func outcome(code: Int, data: Data, error: Error?) -> Outcome {
    if let e = error { return Outcome(state: "retry", message: "net: " + e.localizedDescription) }
    let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let ok = (j?["success"] as? Bool) == true || (j?["success"] as? NSNumber)?.boolValue == true
    if (200...299).contains(code) && ok { return Outcome(state: "sent", message: "") }
    var msg = (j?["message"] as? String) ?? (j?["error"] as? String) ?? ""
    if msg.isEmpty { msg = "HTTP \(code)" }
    if code == 401 || code == 408 || code == 425 || code == 429 || code >= 500 || code == 0 {
      return Outcome(state: "retry", message: msg)
    }
    return Outcome(state: "failed", message: String(msg.prefix(160)))
  }

  static func update(cmi: String, outcome: Outcome) {
    guard let dir = ChatyyShareConst.dir("jobs") else { return }
    let f = dir.appendingPathComponent(cmi + ".json")
    guard let d = try? Data(contentsOf: f), var o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
    o["state"] = outcome.state
    o["err"] = outcome.message
    o["updated_at"] = Date().timeIntervalSince1970 * 1000
    if let body = o["body"] as? String { try? FileManager.default.removeItem(atPath: body) }
    if outcome.state == "sent" {
      try? FileManager.default.removeItem(at: f)
      return
    }
    if let nd = try? JSONSerialization.data(withJSONObject: o) { try? nd.write(to: f, options: .atomic) }
    if outcome.state == "failed" { ChatyyShareDiag.log("error", "send failed cmi=\(cmi): \(outcome.message)") }
  }
}

// MARK: - Avatar

final class ChatyyShareAvatarView: UIView {
  private let imageView = UIImageView()
  private let initials = UILabel()
  private let glyph = UIImageView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = ChatyyShareTheme.fill
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFill
    imageView.translatesAutoresizingMaskIntoConstraints = false
    initials.font = ChatyyShareTheme.font(16, .semibold)
    initials.textColor = ChatyyShareTheme.ink
    initials.textAlignment = .center
    initials.translatesAutoresizingMaskIntoConstraints = false
    glyph.tintColor = ChatyyShareTheme.ink
    glyph.contentMode = .scaleAspectFit
    glyph.translatesAutoresizingMaskIntoConstraints = false
    addSubview(initials); addSubview(glyph); addSubview(imageView)
    NSLayoutConstraint.activate([
      imageView.leadingAnchor.constraint(equalTo: leadingAnchor), imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
      imageView.topAnchor.constraint(equalTo: topAnchor), imageView.bottomAnchor.constraint(equalTo: bottomAnchor),
      initials.centerXAnchor.constraint(equalTo: centerXAnchor), initials.centerYAnchor.constraint(equalTo: centerYAnchor),
      glyph.centerXAnchor.constraint(equalTo: centerXAnchor), glyph.centerYAnchor.constraint(equalTo: centerYAnchor),
      glyph.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.46), glyph.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.46),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    layer.cornerRadius = bounds.width / 2
  }

  private static let cache = NSCache<NSString, UIImage>()

  func configure(_ c: ChatyyShareConversation) {
    imageView.image = nil
    let words = c.title.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" }).prefix(2)
    initials.text = words.compactMap { $0.first.map { String($0).uppercased() } }.joined()
    glyph.image = c.isGroup ? UIImage(systemName: "person.2.fill") : nil
    initials.isHidden = c.isGroup
    guard let url = c.avatarURL else { return }
    let key = url.path as NSString
    if let img = Self.cache.object(forKey: key) { imageView.image = img; return }
    let expected = url.path
    currentPath = expected
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard FileManager.default.fileExists(atPath: expected),
            let img = ChatyyShareLoader.thumbnail(url, maxPixel: 132) else { return }
      Self.cache.setObject(img, forKey: key)
      DispatchQueue.main.async {
        guard let self = self, self.currentPath == expected else { return }
        self.imageView.image = img
      }
    }
  }

  private var currentPath = ""
}

// MARK: - Célula da lista

final class ChatyyShareCell: UITableViewCell {
  static let reuse = "ChatyyShareCell"
  let avatar = ChatyyShareAvatarView()
  let title = UILabel()
  let subtitle = UILabel()
  let check = UIImageView()

  override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
    super.init(style: style, reuseIdentifier: reuseIdentifier)
    backgroundColor = ChatyyShareTheme.bg
    selectionStyle = .none
    for v in [avatar, title, subtitle, check] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; contentView.addSubview(v) }
    title.font = ChatyyShareTheme.font(16, .semibold)
    title.textColor = ChatyyShareTheme.ink
    subtitle.font = ChatyyShareTheme.font(13)
    subtitle.textColor = ChatyyShareTheme.secondary
    check.tintColor = ChatyyShareTheme.ink
    check.contentMode = .scaleAspectFit
    NSLayoutConstraint.activate([
      avatar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
      avatar.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      avatar.widthAnchor.constraint(equalToConstant: 44), avatar.heightAnchor.constraint(equalToConstant: 44),
      title.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
      title.trailingAnchor.constraint(lessThanOrEqualTo: check.leadingAnchor, constant: -12),
      title.bottomAnchor.constraint(equalTo: contentView.centerYAnchor, constant: 1),
      subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
      subtitle.trailingAnchor.constraint(lessThanOrEqualTo: check.leadingAnchor, constant: -12),
      subtitle.topAnchor.constraint(equalTo: contentView.centerYAnchor, constant: 3),
      check.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -18),
      check.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
      check.widthAnchor.constraint(equalToConstant: 24), check.heightAnchor.constraint(equalToConstant: 24),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ c: ChatyyShareConversation, selected: Bool) {
    avatar.configure(c)
    title.text = c.title
    subtitle.text = c.isGroup ? ChatyyShareL10n.group : c.email
    let cfg = UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)
    check.image = UIImage(systemName: selected ? "checkmark.circle.fill" : "circle", withConfiguration: cfg)
    check.tintColor = selected ? ChatyyShareTheme.ink : ChatyyShareTheme.secondary
    accessibilityTraits = selected ? [.button, .selected] : [.button]
  }
}

// MARK: - Barra superior simples

final class ChatyyShareTopBar: UIView {
  let left = UIButton(type: .system)
  let titleLabel = UILabel()
  let right = UIButton(type: .system)

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = ChatyyShareTheme.bg
    for v in [left, titleLabel, right] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
    left.tintColor = ChatyyShareTheme.ink
    right.tintColor = ChatyyShareTheme.ink
    left.titleLabel?.font = ChatyyShareTheme.font(17)
    right.titleLabel?.font = ChatyyShareTheme.font(17, .semibold)
    titleLabel.font = ChatyyShareTheme.font(17, .semibold)
    titleLabel.textColor = ChatyyShareTheme.ink
    titleLabel.textAlignment = .center
    let line = UIView(); line.backgroundColor = ChatyyShareTheme.hairline; line.translatesAutoresizingMaskIntoConstraints = false; addSubview(line)
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 52),
      left.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), left.centerYAnchor.constraint(equalTo: centerYAnchor),
      right.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12), right.centerYAnchor.constraint(equalTo: centerYAnchor),
      titleLabel.centerXAnchor.constraint(equalTo: centerXAnchor), titleLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
      titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: left.trailingAnchor, constant: 8),
      titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: right.leadingAnchor, constant: -8),
      line.leadingAnchor.constraint(equalTo: leadingAnchor), line.trailingAnchor.constraint(equalTo: trailingAnchor),
      line.bottomAnchor.constraint(equalTo: bottomAnchor), line.heightAnchor.constraint(equalToConstant: 1.0 / UIScreen.main.scale),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

// MARK: - Tela 1: escolher conversas

final class ChatyySharePickerController: UIViewController, UITableViewDataSource, UITableViewDelegate, UISearchBarDelegate {
  var conversations: [ChatyyShareConversation] = []
  var selected: [String] = []
  var onCancel: (() -> Void)?
  var onNext: (() -> Void)?
  var onOpenApp: (() -> Void)?

  private let bar = ChatyyShareTopBar()
  private let searchBar = UISearchBar()
  private let table = UITableView(frame: .zero, style: .plain)
  private let footer = UIView()
  private let footerLabel = UILabel()
  private let nextButton = UIButton(type: .custom)
  private let empty = UILabel()
  private var filtered: [ChatyyShareConversation] = []
  private var footerBottom: NSLayoutConstraint?

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = ChatyyShareTheme.bg
    filtered = conversations

    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.left.setTitle(ChatyyShareL10n.cancel, for: .normal)
    bar.left.addTarget(self, action: #selector(tapCancel), for: .touchUpInside)
    bar.titleLabel.text = ChatyyShareL10n.sendTo
    view.addSubview(bar)

    searchBar.translatesAutoresizingMaskIntoConstraints = false
    searchBar.searchBarStyle = .minimal
    searchBar.placeholder = ChatyyShareL10n.search
    searchBar.delegate = self
    searchBar.tintColor = ChatyyShareTheme.ink
    searchBar.autocapitalizationType = .none
    view.addSubview(searchBar)

    table.translatesAutoresizingMaskIntoConstraints = false
    table.dataSource = self
    table.delegate = self
    table.rowHeight = 64
    table.backgroundColor = ChatyyShareTheme.bg
    table.separatorColor = ChatyyShareTheme.hairline
    table.separatorInset = UIEdgeInsets(top: 0, left: 72, bottom: 0, right: 0)
    table.keyboardDismissMode = .onDrag
    table.register(ChatyyShareCell.self, forCellReuseIdentifier: ChatyyShareCell.reuse)
    table.tableFooterView = makeOpenAppFooter()
    view.addSubview(table)

    empty.translatesAutoresizingMaskIntoConstraints = false
    empty.text = ChatyyShareL10n.noResults
    empty.textColor = ChatyyShareTheme.secondary
    empty.font = ChatyyShareTheme.font(15)
    empty.textAlignment = .center
    empty.isHidden = true
    view.addSubview(empty)

    footer.translatesAutoresizingMaskIntoConstraints = false
    footer.backgroundColor = ChatyyShareTheme.bg
    let line = UIView(); line.backgroundColor = ChatyyShareTheme.hairline; line.translatesAutoresizingMaskIntoConstraints = false
    footer.addSubview(line)
    footerLabel.translatesAutoresizingMaskIntoConstraints = false
    footerLabel.font = ChatyyShareTheme.font(15, .medium)
    footerLabel.textColor = ChatyyShareTheme.ink
    footerLabel.lineBreakMode = .byTruncatingTail
    footer.addSubview(footerLabel)
    nextButton.translatesAutoresizingMaskIntoConstraints = false
    nextButton.backgroundColor = ChatyyShareTheme.ink
    nextButton.tintColor = ChatyyShareTheme.inkInverse
    nextButton.setImage(UIImage(systemName: "arrow.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
    nextButton.layer.cornerRadius = 24
    nextButton.accessibilityLabel = ChatyyShareL10n.sendTo
    nextButton.addTarget(self, action: #selector(tapNext), for: .touchUpInside)
    footer.addSubview(nextButton)
    view.addSubview(footer)

    let fb = footer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
    footerBottom = fb
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      bar.leadingAnchor.constraint(equalTo: view.leadingAnchor), bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      searchBar.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 4),
      searchBar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
      searchBar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
      table.topAnchor.constraint(equalTo: searchBar.bottomAnchor),
      table.leadingAnchor.constraint(equalTo: view.leadingAnchor), table.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      table.bottomAnchor.constraint(equalTo: footer.topAnchor),
      empty.centerXAnchor.constraint(equalTo: table.centerXAnchor), empty.topAnchor.constraint(equalTo: table.topAnchor, constant: 48),
      footer.leadingAnchor.constraint(equalTo: view.leadingAnchor), footer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      fb,
      line.topAnchor.constraint(equalTo: footer.topAnchor), line.leadingAnchor.constraint(equalTo: footer.leadingAnchor),
      line.trailingAnchor.constraint(equalTo: footer.trailingAnchor), line.heightAnchor.constraint(equalToConstant: 1.0 / UIScreen.main.scale),
      footerLabel.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 16),
      footerLabel.centerYAnchor.constraint(equalTo: nextButton.centerYAnchor),
      footerLabel.trailingAnchor.constraint(lessThanOrEqualTo: nextButton.leadingAnchor, constant: -12),
      nextButton.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -16),
      nextButton.topAnchor.constraint(equalTo: footer.topAnchor, constant: 10),
      nextButton.bottomAnchor.constraint(equalTo: footer.safeAreaLayoutGuide.bottomAnchor, constant: -10),
      nextButton.widthAnchor.constraint(equalToConstant: 48), nextButton.heightAnchor.constraint(equalToConstant: 48),
    ])
    refreshFooter(animated: false)
  }

  private func makeOpenAppFooter() -> UIView {
    let v = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 64))
    let b = UIButton(type: .system)
    b.setTitle(ChatyyShareL10n.openApp, for: .normal)
    b.titleLabel?.font = ChatyyShareTheme.font(15, .medium)
    b.tintColor = ChatyyShareTheme.secondary
    b.translatesAutoresizingMaskIntoConstraints = false
    b.addTarget(self, action: #selector(tapOpenApp), for: .touchUpInside)
    v.addSubview(b)
    NSLayoutConstraint.activate([b.centerXAnchor.constraint(equalTo: v.centerXAnchor), b.centerYAnchor.constraint(equalTo: v.centerYAnchor)])
    return v
  }

  func refreshFooter(animated: Bool) {
    let names = selected.compactMap { id in conversations.first(where: { $0.id == id })?.title }
    footerLabel.text = names.joined(separator: ", ")
    let show = !selected.isEmpty
    let apply = {
      self.footer.alpha = show ? 1 : 0
      self.footer.isUserInteractionEnabled = show
    }
    if animated { UIView.animate(withDuration: 0.18, animations: apply) } else { apply() }
  }

  func reloadSelection() {
    guard isViewLoaded else { return }
    table.reloadData()
    refreshFooter(animated: false)
  }

  @objc private func tapCancel() { onCancel?() }
  @objc private func tapNext() { if !selected.isEmpty { onNext?() } }
  @objc private func tapOpenApp() { onOpenApp?() }

  func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { return filtered.count }

  func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
    return filtered.isEmpty ? nil : ChatyyShareL10n.recents
  }

  func tableView(_ tableView: UITableView, willDisplayHeaderView view: UIView, forSection section: Int) {
    if let h = view as? UITableViewHeaderFooterView {
      h.textLabel?.font = ChatyyShareTheme.font(12, .semibold)
      h.textLabel?.textColor = ChatyyShareTheme.secondary
      h.contentView.backgroundColor = ChatyyShareTheme.bg
    }
  }

  func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: ChatyyShareCell.reuse, for: indexPath)
    if let c = cell as? ChatyyShareCell {
      let conv = filtered[indexPath.row]
      c.configure(conv, selected: selected.contains(conv.id))
    }
    return cell
  }

  func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    let conv = filtered[indexPath.row]
    if let i = selected.firstIndex(of: conv.id) {
      selected.remove(at: i)
    } else {
      if selected.count >= ChatyyShareConst.maxRecipients {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        showToast(ChatyyShareL10n.maxChats)
        return
      }
      selected.append(conv.id)
      UISelectionFeedbackGenerator().selectionChanged()
    }
    tableView.reloadRows(at: [indexPath], with: .none)
    refreshFooter(animated: true)
  }

  func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
    let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
    filtered = q.isEmpty ? conversations : conversations.filter { $0.searchKey.contains(q) }
    empty.isHidden = !filtered.isEmpty
    table.reloadData()
  }

  func searchBarSearchButtonClicked(_ searchBar: UISearchBar) { searchBar.resignFirstResponder() }

  private func showToast(_ text: String) {
    let l = ChatyySharePaddedLabel()
    l.text = text
    l.font = ChatyyShareTheme.font(14, .medium)
    l.textColor = ChatyyShareTheme.inkInverse
    l.backgroundColor = ChatyyShareTheme.ink
    l.layer.cornerRadius = 16
    l.clipsToBounds = true
    l.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(l)
    NSLayoutConstraint.activate([l.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                                 l.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16)])
    UIView.animate(withDuration: 0.2, delay: 1.6, options: [], animations: { l.alpha = 0 }, completion: { _ in l.removeFromSuperview() })
  }
}

final class ChatyySharePaddedLabel: UILabel {
  override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14))) }
  override var intrinsicContentSize: CGSize {
    let s = super.intrinsicContentSize
    return CGSize(width: s.width + 28, height: s.height + 16)
  }
}

// MARK: - Tela 2: prévia + legenda + enviar

final class ChatyyShareComposeController: UIViewController, UITextViewDelegate, UIScrollViewDelegate {
  var items: [ChatyyShareItem] = []
  var recipients: [ChatyyShareConversation] = []
  var initialText = ""
  var showsBack = true
  var onBack: (() -> Void)?
  var onCancel: (() -> Void)?
  var onSend: ((String) -> Void)?

  private let bar = ChatyyShareTopBar()
  private let stage = UIScrollView()
  private let pageLabel = ChatyySharePaddedLabel()
  private let bottom = UIView()
  private let inputBox = UIView()
  private let textView = UITextView()
  private let placeholder = UILabel()
  private let sendButton = UIButton(type: .custom)
  private var textHeight: NSLayoutConstraint?
  private var mediaItems: [ChatyyShareItem] { return items.filter { $0.isMedia } }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = ChatyyShareTheme.bg

    bar.translatesAutoresizingMaskIntoConstraints = false
    if showsBack {
      bar.left.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
      bar.left.accessibilityLabel = ChatyyShareL10n.sendTo
      bar.left.addTarget(self, action: #selector(tapBack), for: .touchUpInside)
    } else {
      bar.left.setTitle(ChatyyShareL10n.cancel, for: .normal)
      bar.left.addTarget(self, action: #selector(tapCancel), for: .touchUpInside)
    }
    bar.titleLabel.text = ChatyyShareL10n.to + ": " + recipients.map { $0.title }.joined(separator: ", ")
    bar.titleLabel.lineBreakMode = .byTruncatingTail
    view.addSubview(bar)

    stage.translatesAutoresizingMaskIntoConstraints = false
    stage.isPagingEnabled = true
    stage.showsHorizontalScrollIndicator = false
    stage.backgroundColor = ChatyyShareTheme.stage
    stage.delegate = self
    view.addSubview(stage)

    pageLabel.translatesAutoresizingMaskIntoConstraints = false
    pageLabel.font = ChatyyShareTheme.font(13, .semibold)
    pageLabel.textColor = ChatyyShareTheme.inkInverse
    pageLabel.backgroundColor = ChatyyShareTheme.ink.withAlphaComponent(0.75)
    pageLabel.layer.cornerRadius = 14
    pageLabel.clipsToBounds = true
    pageLabel.isHidden = mediaItems.count < 2
    view.addSubview(pageLabel)

    bottom.translatesAutoresizingMaskIntoConstraints = false
    bottom.backgroundColor = ChatyyShareTheme.bg
    view.addSubview(bottom)
    inputBox.translatesAutoresizingMaskIntoConstraints = false
    inputBox.backgroundColor = ChatyyShareTheme.fill
    inputBox.layer.cornerRadius = 20
    bottom.addSubview(inputBox)
    textView.translatesAutoresizingMaskIntoConstraints = false
    textView.backgroundColor = .clear
    textView.font = ChatyyShareTheme.font(16)
    textView.textColor = ChatyyShareTheme.ink
    textView.tintColor = ChatyyShareTheme.ink
    textView.delegate = self
    textView.textContainerInset = UIEdgeInsets(top: 9, left: 8, bottom: 9, right: 8)
    textView.text = initialText
    inputBox.addSubview(textView)
    placeholder.translatesAutoresizingMaskIntoConstraints = false
    placeholder.text = mediaItems.isEmpty ? ChatyyShareL10n.message : ChatyyShareL10n.caption
    placeholder.font = ChatyyShareTheme.font(16)
    placeholder.textColor = ChatyyShareTheme.secondary
    placeholder.isHidden = !initialText.isEmpty
    inputBox.addSubview(placeholder)
    sendButton.translatesAutoresizingMaskIntoConstraints = false
    sendButton.backgroundColor = ChatyyShareTheme.ink
    sendButton.tintColor = ChatyyShareTheme.inkInverse
    sendButton.setImage(UIImage(systemName: "arrow.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .bold)), for: .normal)
    sendButton.layer.cornerRadius = 20
    sendButton.accessibilityLabel = ChatyyShareL10n.t("Enviar", "Send", "Enviar")
    sendButton.addTarget(self, action: #selector(tapSend), for: .touchUpInside)
    bottom.addSubview(sendButton)

    let th = textView.heightAnchor.constraint(equalToConstant: 38)
    textHeight = th
    let stageHeightRule: NSLayoutConstraint
    if mediaItems.isEmpty {
      stageHeightRule = stage.heightAnchor.constraint(equalToConstant: 0)
    } else {
      stageHeightRule = stage.bottomAnchor.constraint(equalTo: bottom.topAnchor)
    }
    NSLayoutConstraint.activate([
      bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      bar.leadingAnchor.constraint(equalTo: view.leadingAnchor), bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stage.topAnchor.constraint(equalTo: bar.bottomAnchor),
      stage.leadingAnchor.constraint(equalTo: view.leadingAnchor), stage.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stageHeightRule,
      pageLabel.topAnchor.constraint(equalTo: stage.topAnchor, constant: 12),
      pageLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      bottom.leadingAnchor.constraint(equalTo: view.leadingAnchor), bottom.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      bottom.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      inputBox.leadingAnchor.constraint(equalTo: bottom.leadingAnchor, constant: 12),
      inputBox.topAnchor.constraint(equalTo: bottom.topAnchor, constant: 8),
      inputBox.bottomAnchor.constraint(equalTo: bottom.safeAreaLayoutGuide.bottomAnchor, constant: -8),
      inputBox.trailingAnchor.constraint(equalTo: sendButton.leadingAnchor, constant: -8),
      textView.leadingAnchor.constraint(equalTo: inputBox.leadingAnchor, constant: 4),
      textView.trailingAnchor.constraint(equalTo: inputBox.trailingAnchor, constant: -4),
      textView.topAnchor.constraint(equalTo: inputBox.topAnchor, constant: 1),
      textView.bottomAnchor.constraint(equalTo: inputBox.bottomAnchor, constant: -1),
      th,
      placeholder.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 13),
      placeholder.topAnchor.constraint(equalTo: textView.topAnchor, constant: 9),
      sendButton.trailingAnchor.constraint(equalTo: bottom.trailingAnchor, constant: -12),
      sendButton.bottomAnchor.constraint(equalTo: inputBox.bottomAnchor),
      sendButton.widthAnchor.constraint(equalToConstant: 40), sendButton.heightAnchor.constraint(equalToConstant: 40),
    ])
    if mediaItems.isEmpty {
      // texto/link: o campo é o editor principal
      textView.font = ChatyyShareTheme.font(17)
      th.isActive = false
      textView.heightAnchor.constraint(greaterThanOrEqualToConstant: 38).isActive = true
      bottom.topAnchor.constraint(equalTo: bar.bottomAnchor).isActive = true
    }
    buildPages()
    updateTextHeight()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    if mediaItems.isEmpty { textView.becomeFirstResponder() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let w = stage.bounds.width, h = stage.bounds.height
    for v in stage.subviews where v.tag >= 100 {
      v.frame = CGRect(x: CGFloat(v.tag - 100) * w, y: 0, width: w, height: h)
    }
    stage.contentSize = CGSize(width: w * CGFloat(mediaItems.count), height: h)
  }

  private func buildPages() {
    for (i, item) in mediaItems.enumerated() {
      let page = UIView()
      page.tag = 100 + i
      if item.kind == .file && item.thumb == nil {
        let icon = UIImageView(image: UIImage(systemName: "doc.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 54, weight: .regular)))
        icon.tintColor = ChatyyShareTheme.ink
        icon.translatesAutoresizingMaskIntoConstraints = false
        let name = UILabel()
        name.text = item.fileName
        name.font = ChatyyShareTheme.font(16, .semibold)
        name.textColor = ChatyyShareTheme.ink
        name.textAlignment = .center
        name.numberOfLines = 2
        name.translatesAutoresizingMaskIntoConstraints = false
        let size = UILabel()
        size.text = ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file)
        size.font = ChatyyShareTheme.font(13)
        size.textColor = ChatyyShareTheme.secondary
        size.translatesAutoresizingMaskIntoConstraints = false
        page.addSubview(icon); page.addSubview(name); page.addSubview(size)
        NSLayoutConstraint.activate([
          icon.centerXAnchor.constraint(equalTo: page.centerXAnchor),
          icon.centerYAnchor.constraint(equalTo: page.centerYAnchor, constant: -28),
          name.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 16),
          name.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 32),
          name.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -32),
          size.topAnchor.constraint(equalTo: name.bottomAnchor, constant: 6),
          size.centerXAnchor.constraint(equalTo: page.centerXAnchor),
        ])
      } else {
        let iv = UIImageView(image: item.thumb)
        iv.contentMode = .scaleAspectFit
        iv.translatesAutoresizingMaskIntoConstraints = false
        page.addSubview(iv)
        NSLayoutConstraint.activate([
          iv.leadingAnchor.constraint(equalTo: page.leadingAnchor), iv.trailingAnchor.constraint(equalTo: page.trailingAnchor),
          iv.topAnchor.constraint(equalTo: page.topAnchor, constant: 8), iv.bottomAnchor.constraint(equalTo: page.bottomAnchor, constant: -8),
        ])
        if item.kind == .video {
          let badge = ChatyySharePaddedLabel()
          let secs = Int(item.duration.isFinite ? item.duration.rounded() : 0)
          badge.text = String(format: "%@  %d:%02d", ChatyyShareL10n.video, secs / 60, secs % 60)
          badge.font = ChatyyShareTheme.font(13, .semibold)
          badge.textColor = UIColor.white
          badge.backgroundColor = UIColor(white: 0, alpha: 0.6)
          badge.layer.cornerRadius = 14
          badge.clipsToBounds = true
          badge.translatesAutoresizingMaskIntoConstraints = false
          let play = UIImageView(image: UIImage(systemName: "play.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 56, weight: .regular)))
          play.tintColor = UIColor.white
          play.translatesAutoresizingMaskIntoConstraints = false
          page.addSubview(play); page.addSubview(badge)
          NSLayoutConstraint.activate([
            play.centerXAnchor.constraint(equalTo: page.centerXAnchor), play.centerYAnchor.constraint(equalTo: page.centerYAnchor),
            badge.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 12),
            badge.bottomAnchor.constraint(equalTo: page.bottomAnchor, constant: -16),
          ])
        }
      }
      stage.addSubview(page)
    }
    updatePageLabel()
  }

  private func updatePageLabel() {
    let w = max(1, stage.bounds.width)
    let i = Int((stage.contentOffset.x / w).rounded())
    pageLabel.text = "\(min(max(i, 0), max(0, mediaItems.count - 1)) + 1)/\(mediaItems.count)"
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) { updatePageLabel() }

  func textViewDidChange(_ textView: UITextView) {
    placeholder.isHidden = !textView.text.isEmpty
    updateTextHeight()
  }

  private func updateTextHeight() {
    guard !mediaItems.isEmpty, let th = textHeight else { return }
    let fit = textView.sizeThatFits(CGSize(width: max(textView.bounds.width, 200), height: .greatestFiniteMagnitude)).height
    th.constant = min(max(38, fit), 120)
    textView.isScrollEnabled = fit > 120
  }

  func enableSend() { sendButton.isEnabled = true }

  @objc private func tapBack() { onBack?() }
  @objc private func tapCancel() { onCancel?() }
  @objc private func tapSend() {
    let text = textView.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if mediaItems.isEmpty && text.isEmpty { return }
    sendButton.isEnabled = false
    textView.resignFirstResponder()
    onSend?(text)
  }
}

// MARK: - Overlay "Enviando…"

final class ChatyyShareProgressOverlay: UIView {
  private let card = UIView()
  private let label = UILabel()
  private let bar = UIProgressView(progressViewStyle: .default)
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let icon = UIImageView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(white: 0, alpha: 0.28)
    card.translatesAutoresizingMaskIntoConstraints = false
    card.backgroundColor = ChatyyShareTheme.bg
    card.layer.cornerRadius = 18
    addSubview(card)
    for v in [label, bar, spinner, icon] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; card.addSubview(v) }
    label.font = ChatyyShareTheme.font(15, .semibold)
    label.textColor = ChatyyShareTheme.ink
    label.textAlignment = .center
    label.numberOfLines = 2
    bar.progressTintColor = ChatyyShareTheme.ink
    bar.trackTintColor = ChatyyShareTheme.hairline
    spinner.color = ChatyyShareTheme.ink
    spinner.startAnimating()
    icon.tintColor = ChatyyShareTheme.ink
    icon.isHidden = true
    NSLayoutConstraint.activate([
      card.centerXAnchor.constraint(equalTo: centerXAnchor), card.centerYAnchor.constraint(equalTo: centerYAnchor),
      card.widthAnchor.constraint(equalToConstant: 250),
      spinner.topAnchor.constraint(equalTo: card.topAnchor, constant: 20), spinner.centerXAnchor.constraint(equalTo: card.centerXAnchor),
      icon.centerXAnchor.constraint(equalTo: spinner.centerXAnchor), icon.centerYAnchor.constraint(equalTo: spinner.centerYAnchor),
      icon.widthAnchor.constraint(equalToConstant: 30), icon.heightAnchor.constraint(equalToConstant: 30),
      label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 12),
      label.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16), label.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
      bar.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 12),
      bar.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20), bar.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
      bar.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func set(_ text: String, progress: Double?) {
    label.text = text
    if let p = progress { bar.isHidden = false; bar.setProgress(Float(p), animated: true) } else { bar.isHidden = true }
  }

  func done(_ text: String) {
    spinner.stopAnimating()
    spinner.isHidden = true
    icon.image = UIImage(systemName: "checkmark.circle.fill")
    icon.isHidden = false
    label.text = text
    bar.setProgress(1, animated: true)
  }
}

// MARK: - Controlador principal (classe do storyboard)

final class ShareViewController: ChatyyShareIntentFallbackController {
  private var nativeSession: ChatyyShareSession?
  private var loader: ChatyyShareLoader?
  private var items: [ChatyyShareItem] = []
  private var loadErrors: [String] = []
  private var loaded = false
  private var picker: ChatyySharePickerController?
  private var current: UIViewController?
  private var preselected: String?
  private var overlay: ChatyyShareProgressOverlay?
  private var sender: ChatyyShareSender?
  private var finished = false
  private var pendingCompose = false
  private let batch = UUID().uuidString.lowercased()

  override func viewDidLoad() {
    var s: ChatyyShareSession? = nil
    if ChatyyShareGate.contentSupported(extensionContext) { s = ChatyyShareGate.session() }
    nativeSession = s
    chatyyLegacyAllowed = (s == nil)
    super.viewDidLoad()   // fallback: o template copia p/ o App Group e abre o app
    guard let session = s else { return }
    // a sugestão tocada é tratada aqui mesmo; não deixa resto p/ o /share-receive
    UserDefaults(suiteName: ChatyyShareConst.appGroup)?.removeObject(forKey: ChatyyShareConst.shareTargetKey)
    view.backgroundColor = ChatyyShareTheme.bg
    view.isOpaque = true
    ChatyyShareDiag.log("info", "native share start convs=\(session.conversations.count)")
    preselected = ChatyyShareGate.preselectedId(extensionContext, in: session.conversations)
    startLoading()
    if let pre = preselected {
      showCompose(recipients: [pre], showsBack: true)
    } else {
      showPicker()
    }
  }

  // MARK: carregamento

  private func startLoading() {
    guard let l = ChatyyShareLoader(batch: batch) else { fallbackToApp("no container"); return }
    loader = l
    l.load(ChatyyShareGate.attachments(extensionContext)) { [weak self] items, errs in
      guard let self = self else { return }
      self.items = items
      self.loadErrors = errs
      self.loaded = true
      if items.isEmpty {
        let tooBig = errs.contains("too_big")
        ChatyyShareDiag.log("error", "load failed: \(errs.joined(separator: " | ").prefix(300))")
        self.hideOverlay()
        self.alert(tooBig ? ChatyyShareL10n.tooBig : ChatyyShareL10n.loadFailed, offerApp: !tooBig)
        return
      }
      if self.pendingCompose {
        self.pendingCompose = false
        self.hideOverlay()
        self.presentComposeNow()
      }
    }
    // iCloud lento: aviso + progresso
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.tickLoading() }
  }

  private func tickLoading() {
    guard !loaded, !finished, let l = loader else { return }
    if pendingCompose { overlay?.set(ChatyyShareL10n.icloud, progress: l.fractionCompleted) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.tickLoading() }
  }

  // MARK: navegação

  private func swap(to vc: UIViewController) {
    if let old = current {
      old.willMove(toParent: nil)
      old.view.removeFromSuperview()
      old.removeFromParent()
    }
    addChild(vc)
    vc.view.frame = view.bounds
    vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.insertSubview(vc.view, at: 0)
    vc.didMove(toParent: self)
    current = vc
  }

  private func showPicker(selected: [String]? = nil) {
    guard let session = nativeSession else { return }
    let p = picker ?? ChatyySharePickerController()
    if let sel = selected { p.selected = sel }
    if picker == nil {
      p.conversations = session.conversations
      p.onCancel = { [weak self] in self?.cancelAll() }
      p.onOpenApp = { [weak self] in self?.fallbackToApp("user") }
      p.onNext = { [weak self] in
        guard let self = self, let p = self.picker else { return }
        self.showCompose(recipients: p.selected, showsBack: true)
      }
      picker = p
    }
    swap(to: p)
    p.reloadSelection()
  }

  private var composeRecipients: [String] = []
  private var composeShowsBack = true

  private func showCompose(recipients: [String], showsBack: Bool) {
    composeRecipients = recipients
    composeShowsBack = showsBack
    if !loaded {
      pendingCompose = true
      showOverlay(ChatyyShareL10n.loading, progress: nil)
      if current == nil {
        let blank = UIViewController()
        blank.view.backgroundColor = ChatyyShareTheme.bg
        swap(to: blank)
      }
      return
    }
    presentComposeNow()
  }

  private func presentComposeNow() {
    guard let session = nativeSession else { return }
    let convs = composeRecipients.compactMap { id in session.conversations.first(where: { $0.id == id }) }
    if convs.isEmpty { showPicker(); return }
    let c = ChatyyShareComposeController()
    c.items = items
    c.recipients = convs
    c.showsBack = composeShowsBack
    let texts = items.filter { !$0.isMedia }.map { $0.text }.filter { !$0.isEmpty }
    c.initialText = texts.joined(separator: "\n")
    c.onBack = { [weak self] in
      guard let self = self else { return }
      self.showPicker(selected: self.composeRecipients)
    }
    c.onCancel = { [weak self] in self?.cancelAll() }
    c.onSend = { [weak self] text in self?.send(caption: text, to: convs) }
    swap(to: c)
  }

  // MARK: envio

  private func send(caption: String, to convs: [ChatyyShareConversation]) {
    guard let session = nativeSession else { return }
    let media = items.filter { $0.isMedia && $0.fileURL != nil }
    var jobs: [ChatyyShareSender.Job] = []
    for conv in convs {
      if media.isEmpty {
        if caption.isEmpty { continue }
        jobs.append(.init(cmi: ChatyyShareSender.newCmi(), conv: conv.id, kind: "text", msgType: "text",
                          file: "", mime: "", fileName: "", caption: caption))
        continue
      }
      for (i, m) in media.enumerated() {
        let t: String = m.kind == .image ? "image" : (m.kind == .video ? "video" : "file")
        jobs.append(.init(cmi: ChatyyShareSender.newCmi(), conv: conv.id, kind: "media", msgType: t,
                          file: m.fileURL!.path, mime: m.mime, fileName: m.fileName, caption: i == 0 ? caption : ""))
      }
    }
    if jobs.isEmpty { return }
    if jobs.count > ChatyyShareConst.maxSends {
      (current as? ChatyyShareComposeController)?.enableSend()
      alert(ChatyyShareL10n.tooMany, offerApp: false, finishOnOk: false)
      return
    }
    let s = ChatyyShareSender(session: session)
    sender = s
    showOverlay(ChatyyShareL10n.sending, progress: media.isEmpty ? nil : 0)
    s.onProgress = { [weak self] f in self?.overlay?.set(ChatyyShareL10n.sending, progress: f) }
    s.onFinish = { [weak self] ok, fails in self?.sendFinished(ok: ok, fails: fails) }
    guard s.send(jobs: jobs) else {
      sender = nil
      hideOverlay()
      alert(ChatyyShareL10n.failed, offerApp: true)
      return
    }
    donate(convs)
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    // Não segura o usuário: depois de alguns segundos a extensão fecha e o
    // upload segue no sistema (o app conclui o que faltar).
    DispatchQueue.main.asyncAfter(deadline: .now() + ChatyyShareConst.foregroundWaitSec) { [weak self] in
      guard let self = self, !self.finished else { return }
      self.overlay?.set(ChatyyShareL10n.background, progress: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in self?.complete() }
    }
  }

  private func sendFinished(ok: Int, fails: [String]) {
    if finished { return }
    if !fails.isEmpty && ok == 0 {
      hideOverlay()
      alert(ChatyyShareL10n.failed + "\n" + (fails.first ?? ""), offerApp: false)
      return
    }
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    // tudo entregue com a extensão na tela → o lote não serve mais a ninguém
    if fails.isEmpty, ok >= (sender?.startedCount ?? Int.max), let l = loader { try? FileManager.default.removeItem(at: l.batchDir) }
    overlay?.done(ChatyyShareL10n.sent)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self] in self?.complete() }
  }

  /// Ajuda a folha de compartilhar a sugerir as conversas usadas (mesmo id da notificação).
  private func donate(_ convs: [ChatyyShareConversation]) {
    for c in convs {
      let handleValue = c.isGroup ? "group_" + c.id : c.email
      if handleValue.isEmpty { continue }
      var image: INImage? = nil
      if let u = c.avatarURL, let d = try? Data(contentsOf: u) { image = INImage(imageData: d) }
      let person = INPerson(personHandle: INPersonHandle(value: handleValue, type: handleValue.contains("@") ? .emailAddress : .unknown),
                            nameComponents: nil, displayName: c.title, image: image, contactIdentifier: nil, customIdentifier: c.id)
      let intent = INSendMessageIntent(recipients: [person], content: nil,
                                       speakableGroupName: c.isGroup ? INSpeakableString(spokenPhrase: c.title) : nil,
                                       conversationIdentifier: "chat_" + c.id, serviceName: "Chatyy", sender: nil)
      if let img = image {
        if c.isGroup { intent.setImage(img, forParameterNamed: \.speakableGroupName) } else { intent.setImage(img, forParameterNamed: \.recipients) }
      }
      let interaction = INInteraction(intent: intent, response: nil)
      interaction.direction = .outgoing
      interaction.groupIdentifier = c.id
      interaction.donate(completion: nil)
    }
  }

  // MARK: saída

  private func complete() {
    if finished { return }
    finished = true
    extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
  }

  private func cancelAll() {
    if finished { return }
    finished = true
    if let l = loader { try? FileManager.default.removeItem(at: l.batchDir) }
    let err = NSError(domain: "com.onemundo.mail.share", code: NSUserCancelledError, userInfo: nil)
    extensionContext?.cancelRequest(withError: err)
  }

  /// Fluxo antigo: o template copia o conteúdo e abre o app em /share-receive.
  private func fallbackToApp(_ why: String) {
    if finished { return }
    finished = true
    ChatyyShareDiag.log("info", "fallback → app (\(why))")
    if let l = loader { try? FileManager.default.removeItem(at: l.batchDir) }
    if let c = current {
      c.willMove(toParent: nil); c.view.removeFromSuperview(); c.removeFromParent()
      current = nil
    }
    hideOverlay()
    view.backgroundColor = .clear
    chatyyRecordShareTarget()
    chatyyStartLegacyFlow()
  }

  private func showOverlay(_ text: String, progress: Double?) {
    let o = overlay ?? ChatyyShareProgressOverlay(frame: view.bounds)
    o.frame = view.bounds
    o.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    o.set(text, progress: progress)
    if o.superview == nil { view.addSubview(o) }
    overlay = o
  }

  private func hideOverlay() {
    overlay?.removeFromSuperview()
    overlay = nil
  }

  private func alert(_ msg: String, offerApp: Bool, finishOnOk: Bool = true) {
    let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
    if offerApp {
      a.addAction(UIAlertAction(title: ChatyyShareL10n.openInApp, style: .default) { [weak self] _ in self?.fallbackToApp("error") })
    }
    a.addAction(UIAlertAction(title: ChatyyShareL10n.ok, style: .cancel) { [weak self] _ in
      guard let self = self else { return }
      if finishOnOk {
        if self.sender != nil { self.complete() } else { self.cancelAll() }
      }
    })
    present(a, animated: true)
  }
}
