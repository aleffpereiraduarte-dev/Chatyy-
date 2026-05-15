// ShareViewController — Chatyy native iOS share extension UI (WhatsApp parity).
//
// Replaced the simple single-tap picker (build 418-420) with a multi-select
// flow modelled on WhatsApp's share sheet:
//   - Cancelar / Enviar para / (Novo grupo)  — top bar
//   - Caption text field
//   - Search bar
//   - Sections: Status / Feed / Frequentemente contatados / Conversas recentes
//   - Each row has a circle checkbox on the right (multi-select)
//   - Bottom bar slides in when ≥1 selected: "N selecionados • [ Enviar ]"
//   - Tapping Enviar fires all uploads in parallel and dismisses on completion
//
// Why all-native: see share_extension_native_path.md memory file. JS-side
// extension hit cold-start auth races + Metro bundle errors in the
// extension's tiny memory budget (≤120MB).

import UIKit
import MobileCoreServices
import UniformTypeIdentifiers
import Intents

// MARK: - Shared payload model

private struct SharedPayload {
    enum Kind: String { case image, video, text, url, file }
    var kind: Kind = .text
    var image: UIImage?
    var fileURL: URL?
    var fileMime: String = "application/octet-stream"
    var fileName: String = "shared"
    var text: String = ""
    var url: String = ""

    var hasMedia: Bool { fileURL != nil }
    var displayPreview: String {
        switch kind {
        case .image: return "🖼️ Imagem"
        case .video: return "🎬 Vídeo"
        case .text:  return "✏️ " + (text.isEmpty ? "Texto" : String(text.prefix(60)))
        case .url:   return "🔗 " + url
        case .file:  return "📎 " + fileName
        }
    }
}

// MARK: - Recent conversation model

private struct ShareConversation {
    let id: String
    let name: String
    let email: String
    let avatarUrl: String
    let type: String
    static func from(dict: [String: Any]) -> ShareConversation? {
        guard let id = (dict["id"] as? String) ?? (dict["id"] as? Int).map(String.init),
              let name = dict["name"] as? String else { return nil }
        return ShareConversation(
            id: id, name: name,
            email: (dict["email"] as? String) ?? "",
            avatarUrl: (dict["avatarUrl"] as? String) ?? "",
            type: (dict["type"] as? String) ?? "direct"
        )
    }
}

// Special sentinel IDs for the Status / Feed / Nova conversa rows so we can
// keep a single `selectedIds: Set<String>` rather than separate flags.
private enum SpecialRowID {
    static let status = "_chatyy_status"
    static let feed = "_chatyy_feed"
    /// BUG #2: "Nova conversa" entry surfaced both above the recents list
    /// and inline in search results when nothing matches. Tapping presents
    /// an alert that takes an email/phone and resolves it server-side
    /// before adding to the destinations list.
    static let newChat = "_chatyy_new_chat"
    /// Prefix for resolved-but-virtual conversations added at runtime via
    /// the "Nova conversa" / lookup flow. These get appended to
    /// `allConversations` so the existing send code path "just works".
    static let virtualPrefix = "_chatyy_virtual:"
}

// MARK: - Main view controller

final class ShareViewController: UIViewController, UISearchBarDelegate {

    private let appGroupId = "group.com.onemundo.mail"
    private let chatyyPurple = UIColor(red: 124/255, green: 58/255, blue: 237/255, alpha: 1)

    // Multi-attachment: iOS Photos picker can hand us 1..10 images at
    // once. We track every payload separately so the user can fire all of
    // them at every selected destination on tap of "Enviar". Mutex on
    // `payloads` because handleAttachment runs callbacks off the main
    // queue and several attachments resolve concurrently.
    private var payloads: [SharedPayload] = []
    private let payloadsLock = NSLock()
    /// First payload, used as the "type representative" for preview/hasMedia
    /// guards. Most flows just need to know "is there media" or "render a
    /// thumbnail" — they don't care that there are 7 of them.
    private var payload: SharedPayload {
        payloadsLock.lock(); defer { payloadsLock.unlock() }
        return payloads.first ?? SharedPayload()
    }
    private func appendPayload(_ p: SharedPayload) {
        payloadsLock.lock(); payloads.append(p); payloadsLock.unlock()
    }
    private var allConversations: [ShareConversation] = []
    private var frequentConversations: [ShareConversation] = []
    private var recentConversations: [ShareConversation] = []

    // Filtered view (search). When user types, sections collapse to a single
    // "Resultados" section to mirror WhatsApp.
    private var searchActive: Bool = false
    private var searchResults: [ShareConversation] = []

    // Selection state — IDs only (special sentinels for status/feed)
    private var selectedIds: Set<String> = []

    // Auth pulled from App Group
    private var authToken: String = ""
    private var authEmail: String = ""
    private var baseUrl: String = "https://chatyy.com.br"

    // UI elements
    private let captionField = UITextField()
    private let searchBar = UISearchBar()
    private let tableView = UITableView(frame: .zero, style: .grouped)
    private let sendBar = UIView()
    private let sendBarLabel = UILabel()
    private let sendButton = UIButton(type: .system)
    private var sendBarBottomConstraint: NSLayoutConstraint?
    private let previewView = UIView()
    private let previewImageView = UIImageView()
    private let previewLabel = UILabel()
    private var sendingOverlay: UIView?
    private var progressLabel: UILabel?

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        loadAppGroupData()
        // BUG #3: when iOS routes the share to us because the user tapped
        // a suggested-contact avatar in the share sheet, the originating
        // INSendMessageIntent is hung off `extensionContext.intent`. Read
        // the conversationIdentifier (we set it in donateRecipient as the
        // conversation_id) and auto-select that contact so Enviar is a
        // single tap. Without this the user lands on the list and the
        // suggestion is effectively ignored — which is exactly the "abre
        // em vazio" symptom in the report.
        preselectFromIntentIfNeeded()
        extractSharedContent { [weak self] in
            DispatchQueue.main.async { self?.setupUI() }
        }
    }

    private func preselectFromIntentIfNeeded() {
        // NSExtensionContext.intent surface is iOS 14+. The app's
        // deployment target (LSMinimumSystemVersion in Info.plist) is 12.0
        // so we have to guard the read or older devices won't link.
        guard #available(iOS 14.0, *),
              let intent = extensionContext?.intent as? INSendMessageIntent
        else { return }
        // 1) Direct conversation match by conversationIdentifier (the value
        //    we set in donateRecipient, which is the chat conv ID).
        if let convId = intent.conversationIdentifier, !convId.isEmpty {
            if allConversations.contains(where: { $0.id == convId }) {
                selectedIds.insert(convId)
                return
            }
        }
        // 2) Recipient handle fallback — match by INPerson's handle value
        //    (typically the email we pass). Useful when conversationIdentifier
        //    drifted but the email is still around.
        if let recipients = intent.recipients {
            for person in recipients {
                // INPersonHandle.value is non-optional String on iOS 10+,
                // but be defensive: an INPerson missing a handle is
                // useless for routing.
                let handleValue = (person.personHandle?.value ?? "").lowercased()
                if handleValue.isEmpty { continue }
                if let match = allConversations.first(where: {
                    $0.email.lowercased() == handleValue
                }) {
                    selectedIds.insert(match.id)
                    return
                }
                // 3) Last-resort: surface as a virtual conversation so
                //    the share still completes even if the recipient is no
                //    longer in our top-30 recents cache.
                let dn = person.displayName
                let name = dn.isEmpty ? handleValue : dn
                let id = SpecialRowID.virtualPrefix + handleValue
                let conv = ShareConversation(id: id, name: name, email: handleValue,
                                             avatarUrl: "", type: "direct")
                allConversations.append(conv)
                recentConversations.append(conv)
                selectedIds.insert(id)
                return
            }
        }
    }

    // MARK: App Group bridge

    private func loadAppGroupData() {
        guard let ud = UserDefaults(suiteName: appGroupId) else { return }
        authToken = ud.string(forKey: "chatyy.auth_token") ?? ""
        authEmail = ud.string(forKey: "chatyy.auth_email") ?? ""
        if let url = ud.string(forKey: "chatyy.base_url"), !url.isEmpty {
            baseUrl = url
        }
        if let data = ud.data(forKey: "chatyy.recent_conversations"),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            allConversations = arr.compactMap { ShareConversation.from(dict: $0) }
            // First 5 → "Frequentemente contatados", rest → "Conversas recentes"
            // (the JS side already sorted by lastMessageAt desc).
            if allConversations.count > 5 {
                frequentConversations = Array(allConversations.prefix(5))
                recentConversations = Array(allConversations.dropFirst(5))
            } else {
                frequentConversations = allConversations
                recentConversations = []
            }
        }
    }

    // MARK: Extract content from extensionContext

    private func extractSharedContent(completion: @escaping () -> Void) {
        // iOS can split a multi-asset share across MULTIPLE inputItems, not
        // a single item with multiple attachments. Photos.app does this for
        // mixed selections. Earlier code only looked at inputItems.first
        // and lost the rest.
        guard let items = extensionContext?.inputItems as? [NSExtensionItem],
              !items.isEmpty else {
            completion(); return
        }
        let group = DispatchGroup()
        for item in items {
            guard let attachments = item.attachments else { continue }
            for attachment in attachments {
                group.enter()
                handleAttachment(attachment) { group.leave() }
            }
        }
        group.notify(queue: .main) { completion() }
    }

    private func handleAttachment(_ attachment: NSItemProvider, done: @escaping () -> Void) {
        let imageType = UTType.image.identifier
        let videoType = UTType.movie.identifier
        let urlType = UTType.url.identifier
        let textType = UTType.text.identifier
        let fileURLType = UTType.fileURL.identifier

        // ⚠️ Check video BEFORE image — iOS .MOV/.MP4 attachments conform
        // to BOTH UTType.image (poster frame) AND UTType.movie. If image
        // wins, every video share lands in handleImageData and uploads
        // a 4MB JPG poster instead of the actual video.
        //
        // We use `loadFileRepresentation(forTypeIdentifier:)` (iOS 11+)
        // instead of legacy `loadItem`. Why:
        //   1. ALWAYS returns a URL to a temp file — never Data, UIImage,
        //      or other surprise types that loadItem can hand back.
        //   2. Forces iCloud Photos to download the asset before calling
        //      the completion handler. loadItem with iCloud assets fails
        //      silently or returns a placeholder.
        //   3. The temp file is deleted after completion returns, so we
        //      copyToAppGroup INSIDE the handler.
        // See: https://developer.apple.com/documentation/foundation/
        //   nsitemprovider/loadfilerepresentation
        if attachment.hasItemConformingToTypeIdentifier(videoType) {
            attachment.loadFileRepresentation(forTypeIdentifier: videoType) { [weak self] url, _ in
                self?.consumeVideoFileURL(url); done()
            }
        } else if attachment.hasItemConformingToTypeIdentifier(imageType) {
            attachment.loadFileRepresentation(forTypeIdentifier: imageType) { [weak self] url, _ in
                self?.consumeImageFileURL(url); done()
            }
        } else if attachment.hasItemConformingToTypeIdentifier(fileURLType) {
            attachment.loadFileRepresentation(forTypeIdentifier: fileURLType) { [weak self] url, _ in
                self?.consumeGenericFileURL(url); done()
            }
        } else if attachment.hasItemConformingToTypeIdentifier(urlType) {
            // Web URLs: legacy loadItem is fine — these are just strings.
            attachment.loadItem(forTypeIdentifier: urlType, options: nil) { [weak self] data, _ in
                if let url = data as? URL {
                    var p = SharedPayload()
                    p.kind = .url
                    p.url = url.absoluteString
                    self?.appendPayload(p)
                }
                done()
            }
        } else if attachment.hasItemConformingToTypeIdentifier(textType) {
            attachment.loadItem(forTypeIdentifier: textType, options: nil) { [weak self] data, _ in
                if let s = data as? String {
                    var p = SharedPayload()
                    p.kind = .text
                    p.text = s
                    self?.appendPayload(p)
                }
                done()
            }
        } else {
            done()
        }
    }

    // MARK: file-rep consumers (work synchronously inside the completion
    // handler before the temp URL is invalidated by the system).

    private func consumeVideoFileURL(_ url: URL?) {
        guard let url = url, let dest = copyToAppGroup(url: url) else { return }
        let ext = dest.pathExtension.lowercased()
        var p = SharedPayload()
        p.kind = .video
        p.fileURL = dest
        p.fileMime = (ext == "mov") ? "video/quicktime" : "video/mp4"
        p.fileName = dest.lastPathComponent
        appendPayload(p)
    }

    private func consumeImageFileURL(_ url: URL?) {
        guard let url = url else { return }
        // Decode for in-memory preview thumbnail.
        let img = UIImage(contentsOfFile: url.path)
        // Persist either as decoded JPG (if we got a UIImage) or by
        // copying the original bytes (HEIC/PNG/whatever).
        var dest: URL?
        if let img = img {
            dest = saveToAppGroup(image: img, originalURL: url)
        } else {
            dest = copyToAppGroup(url: url)
        }
        guard let final = dest else { return }
        let ext = final.pathExtension.lowercased()
        var p = SharedPayload()
        p.kind = .image
        p.image = img
        p.fileURL = final
        p.fileMime = ["png": "image/png", "heic": "image/heic", "heif": "image/heic",
                      "webp": "image/webp", "gif": "image/gif"][ext] ?? "image/jpeg"
        p.fileName = final.lastPathComponent
        appendPayload(p)
    }

    private func consumeGenericFileURL(_ url: URL?) {
        guard let url = url, let dest = copyToAppGroup(url: url) else { return }
        let ext = dest.pathExtension.lowercased()
        var p = SharedPayload()
        p.fileURL = dest
        p.fileName = dest.lastPathComponent
        if ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif"].contains(ext) {
            p.kind = .image
            p.fileMime = "image/jpeg"
        } else if ["mp4", "mov", "m4v", "webm"].contains(ext) {
            p.kind = .video
            p.fileMime = (ext == "mov") ? "video/quicktime" : "video/mp4"
        } else if ext == "pdf" {
            p.kind = .file
            p.fileMime = "application/pdf"
        } else {
            p.kind = .file
            p.fileMime = "application/octet-stream"
        }
        appendPayload(p)
    }

    private func handleImageData(_ data: NSSecureCoding?) {
        var image: UIImage?
        var sourceURL: URL?
        if let url = data as? URL {
            sourceURL = url
            // .heic/.heif from iPhone Photos: UIImage decodes natively.
            image = UIImage(contentsOfFile: url.path)
        } else if let img = data as? UIImage {
            image = img
        } else if let bytes = data as? Data {
            image = UIImage(data: bytes)
        }
        // If we couldn't decode as image but iOS gave us *something*, fall
        // back to writing the raw bytes/copying the URL — at least the
        // upload won't silently disappear.
        if image == nil {
            if let bytes = data as? Data {
                if let dest = writeBytesToAppGroup(data: bytes, ext: "jpg") {
                    var p = SharedPayload()
                    p.kind = .image
                    p.fileURL = dest
                    p.fileMime = "image/jpeg"
                    p.fileName = dest.lastPathComponent
                    appendPayload(p)
                }
            } else if let url = data as? URL, let dest = copyToAppGroup(url: url) {
                var p = SharedPayload()
                p.kind = .image
                p.fileURL = dest
                p.fileMime = "image/jpeg"
                p.fileName = dest.lastPathComponent
                appendPayload(p)
            }
            return
        }
        let dest = saveToAppGroup(image: image!, originalURL: sourceURL)
        var p = SharedPayload()
        p.kind = .image
        p.image = image
        p.fileURL = dest
        p.fileMime = "image/jpeg"
        p.fileName = dest?.lastPathComponent ?? "shared.jpg"
        appendPayload(p)
    }

    private func handleVideoData(_ data: NSSecureCoding?) {
        // iOS hands us EITHER a file URL (the common case for Photos.app
        // local videos) OR a raw Data blob (iCloud videos that triggered
        // download, or apps that hand the bytes inline). Earlier code
        // only handled URL → iCloud videos silently fell through and the
        // user saw "Send" do nothing.
        var dest: URL?
        var ext: String = "mp4"
        if let url = data as? URL {
            ext = url.pathExtension.lowercased()
            if ext.isEmpty { ext = "mp4" }
            dest = copyToAppGroup(url: url)
        } else if let bytes = data as? Data {
            dest = writeBytesToAppGroup(data: bytes, ext: "mp4")
            ext = "mp4"
        }
        guard let final = dest else { return }
        var p = SharedPayload()
        p.kind = .video
        p.fileURL = final
        p.fileMime = (ext == "mov") ? "video/quicktime" : "video/mp4"
        p.fileName = final.lastPathComponent
        appendPayload(p)
    }

    private func writeBytesToAppGroup(data: Data, ext: String) -> URL? {
        guard let dir = appGroupDir() else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("media_\(Int(Date().timeIntervalSince1970)).\(ext)")
        do { try data.write(to: path, options: .atomic); return path }
        catch { return nil }
    }

    private func handleFileData(_ data: NSSecureCoding?) {
        guard let url = data as? URL else { return }
        let dest = copyToAppGroup(url: url)
        let ext = url.pathExtension.lowercased()
        var p = SharedPayload()
        p.kind = .file
        p.fileURL = dest
        p.fileName = dest?.lastPathComponent ?? "shared"
        if ["jpg", "jpeg", "png", "heic", "webp"].contains(ext) {
            p.kind = .image
            p.fileMime = "image/jpeg"
        } else if ["mp4", "mov"].contains(ext) {
            p.kind = .video
            p.fileMime = "video/mp4"
        } else if ext == "pdf" {
            p.fileMime = "application/pdf"
        } else {
            p.fileMime = "application/octet-stream"
        }
        appendPayload(p)
    }

    private func appGroupDir() -> URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?
            .appendingPathComponent("share-staging", isDirectory: true)
    }

    private func saveToAppGroup(image: UIImage, originalURL: URL?) -> URL? {
        guard let dir = appGroupDir() else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = "img_\(Int(Date().timeIntervalSince1970)).jpg"
        let url = dir.appendingPathComponent(name)
        guard let data = image.jpegData(compressionQuality: 0.9) else { return nil }
        try? data.write(to: url, options: .atomic)
        return url
    }

    private func copyToAppGroup(url: URL) -> URL? {
        guard let dir = appGroupDir() else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = "\(Int(Date().timeIntervalSince1970))_\(url.lastPathComponent)"
        let dest = dir.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.copyItem(at: url, to: dest)
            return dest
        } catch {
            return nil
        }
    }

    // MARK: UI

    private func setupUI() {
        if authToken.isEmpty {
            renderLoggedOutState()
            return
        }
        // Defensive: if extractSharedContent silently failed (e.g. iCloud
        // photo not downloaded, unknown UTI), show an explicit error
        // instead of the regular UI — otherwise user taps Send, nothing
        // happens, extension closes, and they think they shipped a video
        // but the server never saw it.
        if payloads.isEmpty {
            renderEmptyContentError()
            return
        }
        renderShareUI()
    }

    private func renderEmptyContentError() {
        let card = UIView()
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let icon = UILabel()
        icon.text = "⚠️"
        icon.font = .systemFont(ofSize: 44)
        icon.textAlignment = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(icon)

        let title = UILabel()
        title.text = "Não consegui ler o conteúdo"
        title.font = .systemFont(ofSize: 17, weight: .bold)
        title.textAlignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(title)

        let body = UILabel()
        body.text = "O vídeo pode estar no iCloud e ainda não foi baixado pro seu iPhone. Abre Fotos, deixa o vídeo carregar (a bolinha de download some) e tenta de novo."
        body.font = .systemFont(ofSize: 14)
        body.numberOfLines = 0
        body.textAlignment = .center
        body.textColor = .secondaryLabel
        body.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(body)

        let close = UIButton(type: .system)
        close.setTitle("Fechar", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        close.tintColor = chatyyPurple
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(close)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            icon.topAnchor.constraint(equalTo: card.topAnchor),
            icon.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            title.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 12),
            title.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            title.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            body.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            close.topAnchor.constraint(equalTo: body.bottomAnchor, constant: 20),
            close.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
    }

    private func renderLoggedOutState() {
        let card = UIView()
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let icon = UILabel()
        icon.text = "🔒"
        icon.font = .systemFont(ofSize: 44)
        icon.textAlignment = .center
        icon.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(icon)

        let title = UILabel()
        title.text = "Faça login no Chatyy"
        title.font = .systemFont(ofSize: 17, weight: .bold)
        title.textAlignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(title)

        let body = UILabel()
        body.text = "Abra o app Chatyy uma vez para compartilhar fotos e vídeos por aqui."
        body.font = .systemFont(ofSize: 14)
        body.numberOfLines = 0
        body.textAlignment = .center
        body.textColor = .secondaryLabel
        body.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(body)

        let close = UIButton(type: .system)
        close.setTitle("Fechar", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        close.tintColor = chatyyPurple
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        close.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(close)

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            card.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            icon.topAnchor.constraint(equalTo: card.topAnchor),
            icon.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            title.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 12),
            title.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            title.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            body.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            body.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            body.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            close.topAnchor.constraint(equalTo: body.bottomAnchor, constant: 20),
            close.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
    }

    private func renderShareUI() {
        // Top bar
        let topBar = UIView()
        topBar.backgroundColor = .systemBackground
        topBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)

        let cancelBtn = UIButton(type: .system)
        cancelBtn.setTitle("Cancelar", for: .normal)
        cancelBtn.titleLabel?.font = .systemFont(ofSize: 16)
        cancelBtn.tintColor = chatyyPurple
        cancelBtn.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        cancelBtn.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(cancelBtn)

        let title = UILabel()
        title.text = "Enviar para"
        title.font = .systemFont(ofSize: 17, weight: .bold)
        title.textAlignment = .center
        title.translatesAutoresizingMaskIntoConstraints = false
        topBar.addSubview(title)

        // Top bar separator
        let sep = UIView()
        sep.backgroundColor = .separator
        sep.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sep)

        // Preview block (small, inline at top above caption)
        previewView.backgroundColor = .secondarySystemBackground
        previewView.layer.cornerRadius = 10
        previewView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(previewView)

        if payload.kind == .image, let img = payload.image {
            previewImageView.image = img
            previewImageView.contentMode = .scaleAspectFill
            previewImageView.clipsToBounds = true
            previewImageView.layer.cornerRadius = 8
            previewImageView.translatesAutoresizingMaskIntoConstraints = false
            previewView.addSubview(previewImageView)

            // "📷 Foto" if 1, "📷 5 fotos" if multiple
            let n = payloads.count
            previewLabel.text = n > 1 ? "📷 \(n) fotos" : "📷 Foto"
            previewLabel.font = .systemFont(ofSize: 13, weight: .medium)
            previewLabel.textColor = .secondaryLabel
            previewLabel.translatesAutoresizingMaskIntoConstraints = false
            previewView.addSubview(previewLabel)

            NSLayoutConstraint.activate([
                previewImageView.leadingAnchor.constraint(equalTo: previewView.leadingAnchor, constant: 8),
                previewImageView.topAnchor.constraint(equalTo: previewView.topAnchor, constant: 8),
                previewImageView.bottomAnchor.constraint(equalTo: previewView.bottomAnchor, constant: -8),
                previewImageView.widthAnchor.constraint(equalToConstant: 50),
                previewLabel.leadingAnchor.constraint(equalTo: previewImageView.trailingAnchor, constant: 12),
                previewLabel.centerYAnchor.constraint(equalTo: previewView.centerYAnchor),
                previewLabel.trailingAnchor.constraint(equalTo: previewView.trailingAnchor, constant: -12),
            ])
        } else {
            previewLabel.text = payload.displayPreview
            previewLabel.numberOfLines = 2
            previewLabel.textColor = .label
            previewLabel.font = .systemFont(ofSize: 14)
            previewLabel.translatesAutoresizingMaskIntoConstraints = false
            previewView.addSubview(previewLabel)
            NSLayoutConstraint.activate([
                previewLabel.topAnchor.constraint(equalTo: previewView.topAnchor, constant: 10),
                previewLabel.bottomAnchor.constraint(equalTo: previewView.bottomAnchor, constant: -10),
                previewLabel.leadingAnchor.constraint(equalTo: previewView.leadingAnchor, constant: 12),
                previewLabel.trailingAnchor.constraint(equalTo: previewView.trailingAnchor, constant: -12),
            ])
        }

        // Caption
        captionField.placeholder = "Adicionar legenda…"
        captionField.borderStyle = .none
        captionField.font = .systemFont(ofSize: 15)
        captionField.backgroundColor = .secondarySystemBackground
        captionField.layer.cornerRadius = 10
        captionField.setLeftPadding(12)
        captionField.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(captionField)

        // Search
        searchBar.placeholder = "Buscar"
        searchBar.delegate = self
        searchBar.searchBarStyle = .minimal
        searchBar.tintColor = chatyyPurple
        searchBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(searchBar)

        // TableView
        tableView.delegate = self
        tableView.dataSource = self
        tableView.separatorStyle = .none
        tableView.backgroundColor = .systemBackground
        tableView.allowsMultipleSelection = true
        tableView.keyboardDismissMode = .onDrag
        tableView.register(ShareRowCell.self, forCellReuseIdentifier: "row")
        tableView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(tableView)

        // Bottom send bar (hidden until selection)
        sendBar.backgroundColor = .secondarySystemBackground
        sendBar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sendBar)

        sendBarLabel.text = "Selecione contatos"
        sendBarLabel.font = .systemFont(ofSize: 14, weight: .medium)
        sendBarLabel.textColor = .secondaryLabel
        sendBarLabel.translatesAutoresizingMaskIntoConstraints = false
        sendBar.addSubview(sendBarLabel)

        sendButton.setTitle("Enviar", for: .normal)
        sendButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .bold)
        sendButton.setTitleColor(.white, for: .normal)
        sendButton.backgroundColor = chatyyPurple
        sendButton.layer.cornerRadius = 22
        sendButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 22, bottom: 0, right: 22)
        sendButton.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        sendButton.translatesAutoresizingMaskIntoConstraints = false
        sendButton.isEnabled = false
        sendButton.alpha = 0.4
        sendBar.addSubview(sendButton)

        let sendBarSep = UIView()
        sendBarSep.backgroundColor = .separator
        sendBarSep.translatesAutoresizingMaskIntoConstraints = false
        sendBar.addSubview(sendBarSep)

        // Layout
        let g = view.safeAreaLayoutGuide

        sendBarBottomConstraint = sendBar.bottomAnchor.constraint(equalTo: g.bottomAnchor)

        NSLayoutConstraint.activate([
            // top bar
            topBar.topAnchor.constraint(equalTo: g.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 44),
            cancelBtn.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 12),
            cancelBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            title.centerXAnchor.constraint(equalTo: topBar.centerXAnchor),
            title.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            sep.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            sep.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sep.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sep.heightAnchor.constraint(equalToConstant: 0.5),

            // preview
            previewView.topAnchor.constraint(equalTo: sep.bottomAnchor, constant: 10),
            previewView.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            previewView.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            previewView.heightAnchor.constraint(equalToConstant: 66),

            // caption
            captionField.topAnchor.constraint(equalTo: previewView.bottomAnchor, constant: 8),
            captionField.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 12),
            captionField.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -12),
            captionField.heightAnchor.constraint(equalToConstant: 40),

            // search
            searchBar.topAnchor.constraint(equalTo: captionField.bottomAnchor, constant: 4),
            searchBar.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 4),
            searchBar.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -4),

            // table
            tableView.topAnchor.constraint(equalTo: searchBar.bottomAnchor),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: sendBar.topAnchor),

            // bottom send bar
            sendBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sendBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sendBar.heightAnchor.constraint(equalToConstant: 64),
            sendBarBottomConstraint!,
            sendBarSep.topAnchor.constraint(equalTo: sendBar.topAnchor),
            sendBarSep.leadingAnchor.constraint(equalTo: sendBar.leadingAnchor),
            sendBarSep.trailingAnchor.constraint(equalTo: sendBar.trailingAnchor),
            sendBarSep.heightAnchor.constraint(equalToConstant: 0.5),
            sendBarLabel.leadingAnchor.constraint(equalTo: sendBar.leadingAnchor, constant: 16),
            sendBarLabel.centerYAnchor.constraint(equalTo: sendBar.centerYAnchor),
            sendButton.trailingAnchor.constraint(equalTo: sendBar.trailingAnchor, constant: -12),
            sendButton.centerYAnchor.constraint(equalTo: sendBar.centerYAnchor),
            sendButton.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func updateSendBar() {
        let n = selectedIds.count
        if n == 0 {
            sendBarLabel.text = "Selecione contatos"
            sendButton.isEnabled = false
            sendButton.alpha = 0.4
        } else {
            sendBarLabel.text = "\(n) selecionado\(n > 1 ? "s" : "")"
            sendButton.isEnabled = true
            sendButton.alpha = 1
        }
    }

    // MARK: Search

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        let q = searchText.lowercased().trimmingCharacters(in: .whitespaces)
        if q.isEmpty {
            searchActive = false
            searchResults = []
        } else {
            searchActive = true
            searchResults = allConversations.filter {
                $0.name.lowercased().contains(q) || $0.email.lowercased().contains(q)
            }
        }
        tableView.reloadData()
    }

    func searchBarCancelButtonClicked(_ searchBar: UISearchBar) {
        searchBar.text = ""
        searchActive = false
        searchResults = []
        tableView.reloadData()
        searchBar.resignFirstResponder()
    }

    // MARK: New chat lookup (BUG #2)

    /// Presents a textField prompt that takes either an email or a phone
    /// number, then resolves it server-side and inserts a fresh
    /// `ShareConversation` into `allConversations` + auto-selects it so
    /// the user can tap Enviar immediately. We avoid creating the real
    /// chat row on the server — `chat_send` + `chat_upload` already do
    /// "get-or-create direct conversation by member email" implicitly, so
    /// the only data we need is the resolved email. For digit-only input
    /// we resolve via `find_by_phone`; for email we just normalise.
    private func presentNewChatPrompt(prefill: String?) {
        let alert = UIAlertController(
            title: "Nova conversa",
            message: "Digite o email ou telefone do contato Chatyy.",
            preferredStyle: .alert
        )
        alert.addTextField { tf in
            tf.placeholder = "email@dominio.com ou +5511…"
            tf.text = prefill
            tf.autocorrectionType = .no
            tf.autocapitalizationType = .none
            tf.keyboardType = .emailAddress
            tf.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel))
        alert.addAction(UIAlertAction(title: "Buscar", style: .default) { [weak self] _ in
            let raw = (alert.textFields?.first?.text ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self?.resolveNewChatQuery(raw)
        })
        present(alert, animated: true)
    }

    /// Resolve the raw query into an email via the backend, then append as
    /// a virtual `ShareConversation` and auto-select.
    private func resolveNewChatQuery(_ raw: String) {
        guard !raw.isEmpty else { return }
        let digits = raw.filter(\.isNumber)
        let looksLikePhone = digits.count >= 8 && digits.count == raw.replacingOccurrences(of: "+", with: "")
            .filter { !$0.isWhitespace && $0 != "-" && $0 != "(" && $0 != ")" }.count
        let looksLikeEmail = raw.contains("@")

        if looksLikeEmail {
            // Direct path — trust the email, normalise lower-case, add and
            // select. chat_send/chat_upload validate the actual recipient
            // when the send fires, so a bogus email surfaces as a normal
            // upload error (not a silent miss).
            let email = raw.lowercased()
            insertVirtualConversation(name: email, email: email)
            return
        }

        if !looksLikePhone {
            showError("Digite um email válido ou um número de telefone com pelo menos 8 dígitos.")
            return
        }

        // Phone lookup via backend.
        showLookupSpinner()
        var req = URLRequest(url: URL(string: "\(baseUrl)/api/email.php?action=find_by_phone")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 15
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["phone": raw])
        ChatyyAPI.session.dataTask(with: req) { [weak self] data, _, err in
            DispatchQueue.main.async {
                self?.hideLookupSpinner()
                if let err = err {
                    self?.showError("Falha na busca: \(err.localizedDescription)")
                    return
                }
                guard let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    self?.showError("Resposta inválida do servidor.")
                    return
                }
                // Backend wraps payload as { success, data:{ results:[…] } } OR
                // returns { results:[…] } at the top level. Accept both.
                let payload = (json["data"] as? [String: Any]) ?? json
                let rows = (payload["results"] as? [[String: Any]])
                    ?? (payload["found"] as? [[String: Any]])
                    ?? []
                guard let first = rows.first,
                      let email = (first["email"] as? String)?.lowercased() else {
                    self?.showError("Ninguém com esse número no Chatyy.")
                    return
                }
                let name = (first["display_name"] as? String)
                    ?? (first["name"] as? String) ?? email
                self?.insertVirtualConversation(name: name, email: email)
            }
        }.resume()
    }

    private func insertVirtualConversation(name: String, email: String) {
        // Dedupe — if the email already exists in our local list, just
        // select that row instead of appending a virtual duplicate.
        if let existing = allConversations.first(where: {
            $0.email.lowercased() == email.lowercased()
        }) {
            selectedIds.insert(existing.id)
            tableView.reloadData()
            updateSendBar()
            return
        }
        let id = SpecialRowID.virtualPrefix + email
        let conv = ShareConversation(id: id, name: name, email: email,
                                     avatarUrl: "", type: "direct")
        allConversations.append(conv)
        recentConversations.append(conv)
        selectedIds.insert(id)
        // Drop search state so the user sees their new contact in Recentes
        // alongside the existing rows.
        if searchActive {
            searchActive = false
            searchResults = []
            searchBar.text = ""
            searchBar.resignFirstResponder()
        }
        tableView.reloadData()
        updateSendBar()
    }

    private var lookupSpinner: UIActivityIndicatorView?
    private func showLookupSpinner() {
        let sp = UIActivityIndicatorView(style: .medium)
        sp.color = chatyyPurple
        sp.translatesAutoresizingMaskIntoConstraints = false
        sp.startAnimating()
        view.addSubview(sp)
        NSLayoutConstraint.activate([
            sp.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            sp.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        lookupSpinner = sp
    }
    private func hideLookupSpinner() {
        lookupSpinner?.removeFromSuperview()
        lookupSpinner = nil
    }

    // MARK: Section bookkeeping

    /// Sections: 0=NovaConversa (1 row, always — BUG #2), 1=Status (1 row,
    /// only if hasMedia), 2=Feed (1 row, only if hasMedia), 3=Frequentes
    /// (top 5), 4=Recentes (rest). When searching, collapse to a single
    /// "Resultados" section; when search returns nothing, surface a
    /// "Buscar contato" lookup row inline (handled inside `cellForRowAt`).
    private enum Section: Int, CaseIterable {
        case newChat = 0, status, feed, frequent, recent, results
    }

    private func visibleSections() -> [Section] {
        if searchActive { return [.results] }
        var s: [Section] = []
        // "Nova conversa" entry sits at the top so the user can always
        // start a brand-new DM, even when there are no recents to surface.
        s.append(.newChat)
        if payload.hasMedia { s.append(.status); s.append(.feed) }
        if !frequentConversations.isEmpty { s.append(.frequent) }
        if !recentConversations.isEmpty { s.append(.recent) }
        return s
    }

    private func sectionAt(_ index: Int) -> Section { visibleSections()[index] }

    private func rowsInSection(_ s: Section) -> Int {
        switch s {
        case .newChat: return 1
        case .status, .feed: return 1
        case .frequent: return frequentConversations.count
        case .recent: return recentConversations.count
        // BUG #2: when the user typed something and we have NO matches,
        // still show one row that lets them resolve the input via the
        // backend (find_by_phone for digits, chat_create direct for emails).
        case .results: return max(searchResults.count, searchActive ? 1 : 0)
        }
    }

    // MARK: Actions

    @objc private func cancel() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    @objc private func sendTapped() {
        guard !selectedIds.isEmpty, !payloads.isEmpty else { return }
        let caption = captionField.text ?? ""

        // Total ops = (selected destinations) × (payloads). Each payload
        // is uploaded separately to each destination so a 5-photo share to
        // 3 contacts = 15 uploads (matches WhatsApp's behaviour).
        let total = selectedIds.count * payloads.count
        showSending(total: total)

        // BUG #1: in an app extension we have no UIApplication-style
        // beginBackgroundTask. The reliable way to keep the URL session
        // alive long enough for the user to see the result is to
        // 1) keep the session strongly referenced (we do — module-level
        //    `_sharedShareExtSession`), and
        // 2) NEVER call `extensionContext.completeRequest` until the
        //    DispatchGroup notifies. The system gives ShareExtensions a
        //    generous post-dismiss grace period as long as they have not
        //    declared themselves "done". We hold off completion in
        //    `group.notify` below so the system keeps us scheduled.
        // The 60s `timeoutIntervalForRequest` ensures we are GUARANTEED
        // to return a result instead of hanging forever.

        var done = 0
        var anyFailure = false
        var lastErr: String? = nil

        let group = DispatchGroup()

        for id in selectedIds {
            // Caption goes only on the FIRST payload (matches WhatsApp).
            // Without this every photo would carry the same caption text.
            for (idx, p) in payloads.enumerated() {
                let useCaption = (idx == 0) ? caption : ""

                group.enter()
                let after: (Bool, String?) -> Void = { [weak self] ok, err in
                    DispatchQueue.main.async {
                        done += 1
                        if !ok { anyFailure = true; lastErr = err }
                        // BUG #1: surface the FIRST failure in the overlay
                        // so the user sees what went wrong, not an opaque
                        // "Enviando" forever. The final alert still summarises
                        // the failure when all tasks finish.
                        if let err = err, !err.isEmpty {
                            self?.progressLabel?.text = "Falha (\(done)/\(total)): \(err.prefix(80))"
                        } else {
                            self?.progressLabel?.text = "Enviando \(done) de \(total)…"
                        }
                        group.leave()
                    }
                }

                if id == SpecialRowID.status {
                    guard p.hasMedia, let f = p.fileURL else {
                        DispatchQueue.main.async {
                            anyFailure = true; lastErr = "Status precisa de mídia"
                            group.leave()
                        }
                        continue
                    }
                    ChatyyAPI.uploadStatus(baseUrl: baseUrl, token: authToken,
                                           fileURL: f, mime: p.fileMime,
                                           caption: useCaption, type: p.kind.rawValue,
                                           completion: after)
                } else if id == SpecialRowID.feed {
                    guard p.hasMedia, let f = p.fileURL else {
                        DispatchQueue.main.async {
                            anyFailure = true; lastErr = "Feed precisa de mídia"
                            group.leave()
                        }
                        continue
                    }
                    ChatyyAPI.uploadFeed(baseUrl: baseUrl, token: authToken,
                                         fileURL: f, mime: p.fileMime,
                                         caption: useCaption, type: p.kind.rawValue,
                                         completion: after)
                } else {
                    guard let conv = (allConversations.first { $0.id == id }) else {
                        DispatchQueue.main.async { group.leave() }
                        continue
                    }
                    // BUG #2: virtual conversation IDs are not real numeric
                    // conversation_ids — they are placeholders for emails
                    // resolved via "Nova conversa". Bounce through
                    // chat_create (type=direct, members=[email]) FIRST so
                    // the upload/send below has a real numeric ID. We do
                    // this lazily-per-send so the user only pays the
                    // round-trip when they actually tap Enviar.
                    let resolveConvId: (@escaping (String?) -> Void) -> Void = { done in
                        if conv.id.hasPrefix(SpecialRowID.virtualPrefix) {
                            ChatyyAPI.ensureDirectConversation(
                                baseUrl: baseUrl, token: authToken,
                                memberEmail: conv.email, completion: done)
                        } else {
                            done(conv.id)
                        }
                    }
                    resolveConvId { [weak self] realId in
                        guard let realId = realId else {
                            DispatchQueue.main.async {
                                anyFailure = true
                                lastErr = "Não foi possível criar conversa com \(conv.email)"
                                done += 1
                                self?.progressLabel?.text = "Falha: contato \(conv.email)"
                                group.leave()
                            }
                            return
                        }
                        if p.hasMedia, let f = p.fileURL {
                            ChatyyAPI.uploadAndSend(baseUrl: baseUrl, token: authToken,
                                                    conversationId: realId, fileURL: f, mime: p.fileMime,
                                                    caption: useCaption, type: p.kind.rawValue,
                                                    completion: after)
                        } else {
                            let txt = !useCaption.isEmpty ? useCaption :
                                (p.kind == .url ? p.url : p.text)
                            if txt.isEmpty {
                                DispatchQueue.main.async { group.leave() }
                                return
                            }
                            ChatyyAPI.sendText(baseUrl: baseUrl, token: authToken,
                                               conversationId: realId, text: txt,
                                               completion: after)
                        }
                    }
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            self?.hideSending()
            if anyFailure {
                self?.showError(lastErr ?? "Falha em alguns envios")
            } else {
                self?.dismissDone()
            }
        }
    }

    // MARK: Loading + finish

    private func showSending(total: Int) {
        let overlay = UIView(frame: view.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = UIColor.black.withAlphaComponent(0.5)

        let card = UIView()
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 16
        card.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(card)

        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = chatyyPurple
        spinner.startAnimating()
        spinner.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(spinner)

        let lbl = UILabel()
        lbl.text = "Enviando 0 de \(total)…"
        lbl.font = .systemFont(ofSize: 15, weight: .semibold)
        lbl.textColor = .label
        lbl.textAlignment = .center
        lbl.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(lbl)
        progressLabel = lbl

        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            card.widthAnchor.constraint(equalToConstant: 240),
            card.heightAnchor.constraint(equalToConstant: 130),
            spinner.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            spinner.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
            lbl.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
            lbl.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            lbl.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
        ])
        view.addSubview(overlay)
        sendingOverlay = overlay
    }

    private func hideSending() {
        sendingOverlay?.removeFromSuperview()
        sendingOverlay = nil
        progressLabel = nil
    }

    private func showError(_ msg: String) {
        let a = UIAlertController(title: "Erro", message: msg, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        present(a, animated: true)
    }

    private func dismissDone() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}

// MARK: - UITableView

extension ShareViewController: UITableViewDataSource, UITableViewDelegate {

    func numberOfSections(in tableView: UITableView) -> Int { visibleSections().count }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rowsInSection(sectionAt(section))
    }

    func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch sectionAt(section) {
        case .newChat: return nil
        case .status: return nil
        case .feed: return nil
        case .frequent: return "Frequentemente contatados"
        case .recent: return "Conversas recentes"
        case .results: return "Resultados"
        }
    }
    func tableView(_ tableView: UITableView, heightForHeaderInSection section: Int) -> CGFloat {
        switch sectionAt(section) {
        case .newChat, .status, .feed: return 0.01
        default: return 28
        }
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath) as! ShareRowCell
        let s = sectionAt(indexPath.section)
        switch s {
        case .newChat:
            // BUG #2: "Nova conversa" — plus-icon row at the top that opens
            // an email/phone prompt and creates a virtual destination on the
            // fly. Never tracked as "selected" (it's a launcher row, not a
            // destination), so we always render it deselected.
            cell.configureSpecial(emoji: "+", title: "Nova conversa",
                                  subtitle: "Buscar contato por email ou telefone",
                                  bg: chatyyPurple.withAlphaComponent(0.16),
                                  selected: false,
                                  accent: chatyyPurple)
        case .status:
            cell.configureSpecial(emoji: "📷", title: "Meu status",
                                  subtitle: "Visível 24h pros seus contatos",
                                  bg: UIColor.systemYellow.withAlphaComponent(0.18),
                                  selected: selectedIds.contains(SpecialRowID.status),
                                  accent: chatyyPurple)
        case .feed:
            cell.configureSpecial(emoji: "✨", title: "Postar no Feed",
                                  subtitle: "Publicação visível pros seus seguidores",
                                  bg: UIColor.systemPink.withAlphaComponent(0.15),
                                  selected: selectedIds.contains(SpecialRowID.feed),
                                  accent: chatyyPurple)
        case .frequent:
            let conv = frequentConversations[indexPath.row]
            cell.configureContact(conv: conv,
                                  selected: selectedIds.contains(conv.id),
                                  accent: chatyyPurple)
        case .recent:
            let conv = recentConversations[indexPath.row]
            cell.configureContact(conv: conv,
                                  selected: selectedIds.contains(conv.id),
                                  accent: chatyyPurple)
        case .results:
            // BUG #2: zero local matches → render a single "Buscar @<query>"
            // row that triggers a server-side lookup on tap.
            if searchResults.isEmpty {
                let q = searchBar.text ?? ""
                cell.configureSpecial(emoji: "🔍",
                                      title: "Buscar contato",
                                      subtitle: q.isEmpty ? "Digite email ou telefone" : q,
                                      bg: chatyyPurple.withAlphaComponent(0.12),
                                      selected: false,
                                      accent: chatyyPurple)
            } else {
                let conv = searchResults[indexPath.row]
                cell.configureContact(conv: conv,
                                      selected: selectedIds.contains(conv.id),
                                      accent: chatyyPurple)
            }
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let s = sectionAt(indexPath.section)

        // BUG #2: special-case the launcher rows BEFORE we treat the tap as
        // a multi-select toggle. Tapping "Nova conversa" or the empty-state
        // search row both open the same email/phone prompt.
        if s == .newChat {
            presentNewChatPrompt(prefill: nil)
            return
        }
        if s == .results, searchResults.isEmpty {
            presentNewChatPrompt(prefill: searchBar.text)
            return
        }

        let id: String
        switch s {
        case .newChat: return // already handled above
        case .status: id = SpecialRowID.status
        case .feed: id = SpecialRowID.feed
        case .frequent: id = frequentConversations[indexPath.row].id
        case .recent: id = recentConversations[indexPath.row].id
        case .results: id = searchResults[indexPath.row].id
        }
        if selectedIds.contains(id) { selectedIds.remove(id) }
        else { selectedIds.insert(id) }
        UISelectionFeedbackGenerator().selectionChanged()
        // Reload just this row for visual feedback
        tableView.reloadRows(at: [indexPath], with: .none)
        updateSendBar()
    }

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat { 64 }
}

// MARK: - Share row cell (used for both special rows and contacts)

private final class ShareRowCell: UITableViewCell {
    private let avatar = UIImageView()
    private let nameLabel = UILabel()
    private let subtitleLabel = UILabel()
    private let checkbox = UIView()
    private let checkmark = UIImageView()
    private var avatarTask: URLSessionDataTask?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: .default, reuseIdentifier: reuseIdentifier)
        backgroundColor = .systemBackground
        selectionStyle = .none

        avatar.contentMode = .scaleAspectFill
        avatar.layer.cornerRadius = 22
        avatar.layer.masksToBounds = true
        avatar.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(avatar)

        nameLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(nameLabel)

        subtitleLabel.font = .systemFont(ofSize: 13)
        subtitleLabel.textColor = .secondaryLabel
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(subtitleLabel)

        checkbox.layer.cornerRadius = 12
        checkbox.layer.borderWidth = 1.5
        checkbox.layer.borderColor = UIColor.systemGray3.cgColor
        checkbox.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(checkbox)

        checkmark.image = UIImage(systemName: "checkmark")
        checkmark.tintColor = .white
        checkmark.contentMode = .scaleAspectFit
        checkmark.translatesAutoresizingMaskIntoConstraints = false
        checkbox.addSubview(checkmark)

        NSLayoutConstraint.activate([
            avatar.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 14),
            avatar.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            avatar.widthAnchor.constraint(equalToConstant: 44),
            avatar.heightAnchor.constraint(equalToConstant: 44),
            nameLabel.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
            nameLabel.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12),
            nameLabel.trailingAnchor.constraint(lessThanOrEqualTo: checkbox.leadingAnchor, constant: -8),
            subtitleLabel.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
            subtitleLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 2),
            subtitleLabel.trailingAnchor.constraint(lessThanOrEqualTo: checkbox.leadingAnchor, constant: -8),
            checkbox.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -16),
            checkbox.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            checkbox.widthAnchor.constraint(equalToConstant: 24),
            checkbox.heightAnchor.constraint(equalToConstant: 24),
            checkmark.centerXAnchor.constraint(equalTo: checkbox.centerXAnchor),
            checkmark.centerYAnchor.constraint(equalTo: checkbox.centerYAnchor),
            checkmark.widthAnchor.constraint(equalToConstant: 14),
            checkmark.heightAnchor.constraint(equalToConstant: 14),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }

    private func setSelectionState(_ selected: Bool, accent: UIColor) {
        if selected {
            checkbox.backgroundColor = accent
            checkbox.layer.borderColor = accent.cgColor
            checkmark.isHidden = false
        } else {
            checkbox.backgroundColor = .clear
            checkbox.layer.borderColor = UIColor.systemGray3.cgColor
            checkmark.isHidden = true
        }
    }

    func configureSpecial(emoji: String, title: String, subtitle: String,
                          bg: UIColor, selected: Bool, accent: UIColor) {
        avatarTask?.cancel(); avatarTask = nil
        nameLabel.text = title
        subtitleLabel.text = subtitle
        setSelectionState(selected, accent: accent)
        // Render emoji avatar
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 44, height: 44))
        avatar.image = renderer.image { ctx in
            bg.setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: 44, height: 44))
            let para = NSMutableParagraphStyle(); para.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 22),
                .paragraphStyle: para,
            ]
            emoji.draw(in: CGRect(x: 0, y: 8, width: 44, height: 28), withAttributes: attrs)
        }
    }

    func configureContact(conv: ShareConversation, selected: Bool, accent: UIColor) {
        nameLabel.text = conv.name
        subtitleLabel.text = conv.email
        setSelectionState(selected, accent: accent)

        // Initials placeholder while avatar loads
        let initials = (conv.name.first.map { String($0).uppercased() }) ?? "?"
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 44, height: 44))
        avatar.image = renderer.image { ctx in
            UIColor.systemPurple.withAlphaComponent(0.18).setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: 44, height: 44))
            let para = NSMutableParagraphStyle(); para.alignment = .center
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 16, weight: .bold),
                .foregroundColor: UIColor.systemPurple,
                .paragraphStyle: para,
            ]
            initials.draw(in: CGRect(x: 0, y: 12, width: 44, height: 22), withAttributes: attrs)
        }

        avatarTask?.cancel()
        if !conv.avatarUrl.isEmpty, let url = URL(string: conv.avatarUrl) {
            avatarTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                guard let data = data, let img = UIImage(data: data) else { return }
                DispatchQueue.main.async { self?.avatar.image = img }
            }
            avatarTask?.resume()
        }
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        avatarTask?.cancel()
        avatarTask = nil
    }
}

// MARK: - HTTP API
//
// IMPORTANT: ShareExtension upload reliability.
//
// Originally this used `URLSession.shared` for both text sends and multipart
// file uploads. That mostly works, but in a ShareExtension, the process is
// extremely short-lived — the system can suspend or terminate the extension
// the moment the user dismisses the sheet (which happens IMMEDIATELY when
// our overlay shows "Enviando…" if iOS thinks the extension is done). The
// shared session has no host process to outlive the extension, so the task
// is cancelled and the completion handler never fires — that's why users
// reported "spinner infinito" (the request was killed and we never showed
// an error).
//
// Fix: keep a process-scoped session with an explicit timeout so we ALWAYS
// see either success, failure, or timeout — never "stuck forever". We do
// NOT use a backgroundSessionConfiguration here because that path requires
// a completion handler wired into the host app's AppDelegate
// (`application(_:handleEventsForBackgroundURLSession:)`) and a sharedContainer,
// which adds significant moving parts and surfaces a different class of bugs
// (handler dropped, App Group identifier mismatch, etc.). A 60s explicit
// timeout reliably produces an error toast the user can react to instead.
private let _sharedShareExtSession: URLSession = {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 60     // server roundtrip
    cfg.timeoutIntervalForResource = 120   // total upload including retries
    cfg.waitsForConnectivity = true
    cfg.allowsCellularAccess = true
    cfg.sharedContainerIdentifier = "group.com.onemundo.mail"
    return URLSession(configuration: cfg)
}()

private enum ChatyyAPI {

    static var session: URLSession { _sharedShareExtSession }

    static func sendText(baseUrl: String, token: String, conversationId: String, text: String,
                         completion: @escaping (Bool, String?) -> Void) {
        var req = URLRequest(url: URL(string: "\(baseUrl)/api/email.php?action=chat_send")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 30
        let body: [String: Any] = [
            "conversation_id": Int(conversationId) ?? conversationId,
            "content": text,
            "type": "text",
            "client_message_id": "shareext-\(UUID().uuidString)"
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: req) { data, resp, err in
            handleJSONResponse(data: data, resp: resp, err: err, completion: completion)
        }.resume()
    }

    /// BUG #2: resolve a `member email` into a real numeric conversation_id
    /// by hitting `chat_create` with type=direct. Backend de-dupes: it
    /// returns the existing direct chat if one already exists between the
    /// two users, otherwise it creates a new one. Either way we end up
    /// with a numeric ID we can pass to chat_send/chat_upload.
    static func ensureDirectConversation(baseUrl: String, token: String,
                                         memberEmail: String,
                                         completion: @escaping (String?) -> Void) {
        var req = URLRequest(url: URL(string: "\(baseUrl)/api/email.php?action=chat_create")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 20
        let body: [String: Any] = [
            "type": "direct",
            "members": [memberEmail],
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        session.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { completion(nil); return }
            // Backend returns either { id } at top level, { data: { id } },
            // or { conversation_id }. Cover all three.
            let payload = (json["data"] as? [String: Any]) ?? json
            if let id = payload["id"] {
                completion(String(describing: id))
            } else if let id = payload["conversation_id"] {
                completion(String(describing: id))
            } else if let id = json["id"] {
                completion(String(describing: id))
            } else {
                completion(nil)
            }
        }.resume()
    }

    static func uploadAndSend(baseUrl: String, token: String, conversationId: String,
                              fileURL: URL, mime: String, caption: String, type: String,
                              completion: @escaping (Bool, String?) -> Void) {
        upload(baseUrl: baseUrl, token: token, action: "chat_upload",
               fileFieldName: "file",
               fileURL: fileURL, mime: mime,
               extraFields: ["conversation_id": conversationId,
                             "content": caption,
                             "type": type]) { ok, msg, _ in
            completion(ok, msg)
        }
    }

    static func uploadStatus(baseUrl: String, token: String, fileURL: URL, mime: String,
                             caption: String, type: String,
                             completion: @escaping (Bool, String?) -> Void) {
        upload(baseUrl: baseUrl, token: token, action: "status_upload",
               fileFieldName: "file",
               fileURL: fileURL, mime: mime, extraFields: [:]) { ok, msg, payload in
            if !ok {
                completion(false, msg ?? "upload failed"); return
            }
            let mediaUrl = (payload?["url"] as? String) ?? ""
            if mediaUrl.isEmpty { completion(false, "empty url"); return }
            let absUrl = mediaUrl.hasPrefix("http") ? mediaUrl : baseUrl + mediaUrl

            var req = URLRequest(url: URL(string: "\(baseUrl)/api/email.php?action=status_publish")!)
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.timeoutInterval = 30
            let body: [String: Any] = [
                "content": caption,
                "media_url": absUrl,
                "type": type,
            ]
            req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            session.dataTask(with: req) { data, resp, err in
                handleJSONResponse(data: data, resp: resp, err: err, completion: completion)
            }.resume()
        }
    }

    static func uploadFeed(baseUrl: String, token: String, fileURL: URL, mime: String,
                           caption: String, type: String,
                           completion: @escaping (Bool, String?) -> Void) {
        upload(baseUrl: baseUrl, token: token, action: "feed_create_post",
               fileFieldName: "media",
               fileURL: fileURL, mime: mime,
               extraFields: ["caption": caption, "media_type": type]) { ok, msg, _ in
            completion(ok, msg)
        }
    }

    private static func upload(baseUrl: String, token: String, action: String,
                               fileFieldName: String,
                               fileURL: URL, mime: String,
                               extraFields: [String: String],
                               completion: @escaping (Bool, String?, [String: Any]?) -> Void) {
        guard let url = URL(string: "\(baseUrl)/api/email.php?action=\(action)") else {
            completion(false, "Invalid URL", nil); return
        }

        // BUG #1 fix: surface read errors instead of silently uploading a body
        // with no file part (which the server accepts as "no file" and the
        // user perceives as a frozen spinner that "never completes"). Also
        // bail before allocating a huge body for files we know we can't ship
        // through email.php's 50MB upload cap.
        let fileData: Data
        do {
            // Use .mappedIfSafe to avoid keeping the whole file in RAM for
            // large videos. Defends against the 120MB extension memory cap.
            fileData = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        } catch {
            completion(false, "Falha ao ler arquivo: \(error.localizedDescription)", nil)
            return
        }
        let maxBytes = 50 * 1024 * 1024
        if fileData.count > maxBytes {
            let mb = Double(fileData.count) / 1024.0 / 1024.0
            completion(false, String(format: "Arquivo muito grande (%.1fMB, max 50MB)", mb), nil)
            return
        }

        let boundary = "Boundary-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // Allow up to 60s for the server to round-trip a large upload. The
        // shared session config above also enforces a 120s ceiling so we are
        // GUARANTEED to come back to the user with a result (success, fail,
        // or timeout). Earlier code with no per-request timeout could hang
        // until the system killed the extension, leaving the spinner spinning.
        req.timeoutInterval = 60

        var body = Data()
        for (k, v) in extraFields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(k)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(v)\r\n".data(using: .utf8)!)
        }
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(fileFieldName)\"; filename=\"\(fileURL.lastPathComponent)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n".data(using: .utf8)!)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        let task = session.uploadTask(with: req, from: body) { data, resp, err in
            if let err = err { completion(false, err.localizedDescription, nil); return }
            guard let http = resp as? HTTPURLResponse else { completion(false, "no response", nil); return }
            if http.statusCode >= 400 {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                completion(false, "HTTP \(http.statusCode): \(bodyStr.prefix(200))", nil); return
            }
            // CRITICAL: never default to "success" when the server returns
            // non-JSON or omits the success flag. Earlier code defaulted to
            // true → if a proxy returned an HTML 200 error page or empty
            // body, we silently reported "uploaded" and the extension
            // dismissed as if everything worked. The user saw the bubble
            // appear in chat but the file never landed on the server.
            guard let data = data, !data.isEmpty else {
                completion(false, "empty body", nil); return
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                let bodyStr = String(data: data, encoding: .utf8) ?? ""
                completion(false, "non-JSON: \(bodyStr.prefix(200))", nil); return
            }
            // Accept either explicit success=true OR backend shape with
            // "data" / "message_id" / "id" keys (chat_upload returns those
            // without an explicit "success" field on success).
            let explicitSuccess = json["success"] as? Bool
            let hasMessageId = (json["message_id"] != nil) || (json["id"] != nil) ||
                               ((json["data"] as? [String: Any])?["id"] != nil) ||
                               ((json["data"] as? [String: Any])?["message_id"] != nil) ||
                               (json["url"] != nil)
            let success = explicitSuccess ?? hasMessageId
            let payload = (json["data"] as? [String: Any]) ?? json
            completion(success, success ? nil : (json["message"] as? String) ?? "unknown server response", payload)
        }
        task.resume()
    }

    private static func handleJSONResponse(data: Data?, resp: URLResponse?, err: Error?,
                                           completion: @escaping (Bool, String?) -> Void) {
        if let err = err { completion(false, err.localizedDescription); return }
        guard let http = resp as? HTTPURLResponse else { completion(false, "no response"); return }
        if http.statusCode >= 400 {
            let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            completion(false, "HTTP \(http.statusCode): \(bodyStr.prefix(200))"); return
        }
        guard let data = data, !data.isEmpty else {
            completion(false, "empty body"); return
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            let bodyStr = String(data: data, encoding: .utf8) ?? ""
            completion(false, "non-JSON: \(bodyStr.prefix(200))"); return
        }
        let explicitSuccess = json["success"] as? Bool
        let hasMessageId = (json["message_id"] != nil) || (json["id"] != nil) ||
                           ((json["data"] as? [String: Any])?["id"] != nil)
        let success = explicitSuccess ?? hasMessageId
        completion(success, success ? nil : (json["message"] as? String) ?? "unknown server response")
    }
}

// MARK: - Helpers

private extension UITextField {
    func setLeftPadding(_ amount: CGFloat) {
        let pad = UIView(frame: CGRect(x: 0, y: 0, width: amount, height: 1))
        leftView = pad
        leftViewMode = .always
    }
}
