import UserNotifications
import Intents
import ImageIO
import CryptoKit

/// Chatyy Notification Service Extension (UNNotificationServiceExtension).
///
/// Runs on EVERY chat push (backend sets mutable-content=1) — app killed or not:
///   1. Delivered-on-receipt: POST the signed `d_ack` → sender sees ✓✓ gray.
///   2. [2026-10-07 recv-native] Communication Notification (WhatsApp/iMessage
///      look): INSendMessageIntent + INPerson with the sender's avatar (group
///      photo + group name for groups), donated, then content.updating(from:).
///      Needs the "Communication Notifications" capability on the APP
///      (com.apple.developer.usernotifications.communication) + Info.plist
///      NSUserActivityTypes=[INSendMessageIntent]. Without the entitlement
///      updating(from:) throws → we fall back to the classic banner with the
///      avatar as a thumbnail attachment (previous behavior).
///   3. thread-identifier = chat_<conversation> (one stack per conversation)
///      and category chat_message / chat_mention (Responder / Marcar como lida).
///   4. Rich media: photo/video poster attached (never the avatar when the
///      communication layout already shows it).
///
/// Limits respected: ~30 s wall time (each download ≤ 8 s, everything in
/// parallel, serviceExtensionTimeWillExpire delivers the best attempt) and the
/// ~24 MB memory ceiling (media is streamed to disk; avatars are downsampled
/// with ImageIO to 256 px and never decoded at full size; 3 MB cap).
///
/// Payload shapes: FCM-direct puts our data at top level; Expo puts it in a
/// "body" DICTIONARY (sometimes a JSON string) — both are merged here.
///
/// Source of truth: plugins/notification-service/NotificationService.swift
/// (copied into ios/ChatyyNotificationService/ by with-notification-service.js).
class NotificationService: UNNotificationServiceExtension {

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?
    private var tasks: [URLSessionTask] = []
    private var delivered = false
    private let lock = NSLock()

    private static let chatTypes: Set<String> = ["chat_message", "chat_mention", "chat_keyword", "chat_reaction"]
    private static let downloadTimeout: TimeInterval = 8
    private static let maxAvatarBytes = 3 * 1024 * 1024

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let best = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        self.bestAttemptContent = best

        let p = Self.payload(request.content.userInfo)
        Self.reportDelivered(p)
        // [2026-10-07 bgsync] Store the message in the App Group journal so the
        // app shows it instantly on open (merged before first paint by
        // services/bgJournal.js). No-op without the App Group entitlement.
        Self.journalMessage(p)

        let type = Self.str(p, "type") ?? ""
        let isChat = Self.chatTypes.contains(type)
        let conv = Self.str(p, "conversation_id") ?? ""
        let locked = Self.str(p, "locked") == "1"
        let isGroup = Self.isTrue(Self.str(p, "is_group")) || Self.str(p, "conversation_type") == "group"

        if isChat && !conv.isEmpty {
            if best.threadIdentifier.isEmpty { best.threadIdentifier = "chat_" + conv }
            if best.categoryIdentifier.isEmpty {
                best.categoryIdentifier = (type == "chat_mention") ? "chat_mention" : "chat_message"
            }
        }

        let imageIsAvatar = Self.str(p, "image_is_avatar") == "1"
        let mediaURL: URL? = imageIsAvatar ? nil : Self.extractImageURL(from: p)
        let avatarURL: URL? = (isChat && !locked) ? Self.httpsURL(Self.str(p, "sender_avatar")
            ?? (imageIsAvatar ? Self.str(p, "image") : nil)) : nil
        let groupAvatarURL: URL? = (isChat && !locked && isGroup) ? Self.httpsURL(Self.str(p, "group_avatar")) : nil

        let group = DispatchGroup()
        var mediaAttachment: UNNotificationAttachment?
        var avatarData: Data?
        var groupAvatarData: Data?
        let resultLock = NSLock()

        if let u = mediaURL {
            group.enter()
            let t = Self.downloadAttachment(u) { att in
                resultLock.lock(); mediaAttachment = att; resultLock.unlock()
                group.leave()
            }
            addTask(t)
        }
        if let u = avatarURL {
            group.enter()
            let t = Self.loadAvatar(u) { d in
                resultLock.lock(); avatarData = d; resultLock.unlock()
                group.leave()
            }
            if let t = t { addTask(t) }
        }
        if let u = groupAvatarURL {
            group.enter()
            let t = Self.loadAvatar(u) { d in
                resultLock.lock(); groupAvatarData = d; resultLock.unlock()
                group.leave()
            }
            if let t = t { addTask(t) }
        }

        group.notify(queue: DispatchQueue.global(qos: .userInitiated)) { [weak self] in
            guard let self = self else { return }
            resultLock.lock()
            let media = mediaAttachment, avatar = avatarData, groupAvatar = groupAvatarData
            resultLock.unlock()
            if let a = media { best.attachments = [a] }

            guard isChat, !locked, !conv.isEmpty else {
                self.finish(best)
                return
            }
            if #available(iOS 15.0, *) {
                self.applyCommunication(best: best, p: p, conv: conv, isGroup: isGroup,
                                        avatar: avatar, groupAvatar: groupAvatar) { updated in
                    if let updated = updated {
                        self.finish(updated)
                    } else {
                        Self.attachAvatarFallback(best, avatar: avatar)
                        self.finish(best)
                    }
                }
            } else {
                Self.attachAvatarFallback(best, avatar: avatar)
                self.finish(best)
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let pending = tasks
        lock.unlock()
        pending.forEach { $0.cancel() }
        if let best = bestAttemptContent { finish(best) }
    }

    // MARK: - Delivery (exactly once)

    private func finish(_ content: UNNotificationContent) {
        lock.lock()
        if delivered { lock.unlock(); return }
        delivered = true
        let handler = contentHandler
        lock.unlock()
        handler?(content)
    }

    private func addTask(_ t: URLSessionTask) {
        lock.lock(); tasks.append(t); lock.unlock()
    }

    // MARK: - Communication Notification (iOS 15+)

    @available(iOS 15.0, *)
    private func applyCommunication(best: UNMutableNotificationContent,
                                    p: [String: Any],
                                    conv: String,
                                    isGroup: Bool,
                                    avatar: Data?,
                                    groupAvatar: Data?,
                                    done: @escaping (UNNotificationContent?) -> Void) {
        let senderEmail = Self.str(p, "sender_email") ?? ""
        let senderName = Self.str(p, "sender_name") ?? best.title
        let groupName = Self.str(p, "group_name") ?? Self.str(p, "conversation_name") ?? best.title
        let preview = Self.str(p, "msg_preview")

        let senderImage: INImage? = avatar.map { INImage(imageData: $0) }
        let handle = INPersonHandle(value: senderEmail.isEmpty ? senderName : senderEmail,
                                    type: senderEmail.isEmpty ? .unknown : .emailAddress)
        let sender = INPerson(personHandle: handle,
                              nameComponents: nil,
                              displayName: senderName,
                              image: senderImage,
                              contactIdentifier: nil,
                              customIdentifier: senderEmail.isEmpty ? nil : senderEmail,
                              isMe: false,
                              suggestionType: .none)

        var recipients: [INPerson]? = nil
        var speakableGroup: INSpeakableString? = nil
        if isGroup {
            speakableGroup = INSpeakableString(spokenPhrase: groupName)
            // iOS only renders the group layout (group photo + "Sender — Group")
            // with 2+ recipients; the payload doesn't carry the member list, so
            // the user + a stable group placeholder stand in.
            let me = INPerson(personHandle: INPersonHandle(value: "me", type: .unknown),
                              nameComponents: nil, displayName: nil, image: nil,
                              contactIdentifier: nil, customIdentifier: "me",
                              isMe: true, suggestionType: .none)
            let groupPerson = INPerson(personHandle: INPersonHandle(value: "group_" + conv, type: .unknown),
                                       nameComponents: nil, displayName: groupName, image: nil,
                                       contactIdentifier: nil, customIdentifier: "group_" + conv,
                                       isMe: false, suggestionType: .none)
            recipients = [me, groupPerson]
        }

        let intent = INSendMessageIntent(recipients: recipients,
                                         outgoingMessageType: .outgoingMessageText,
                                         content: (preview?.isEmpty == false) ? preview : best.body,
                                         speakableGroupName: speakableGroup,
                                         conversationIdentifier: "chat_" + conv,
                                         serviceName: nil,
                                         sender: sender,
                                         attachments: nil)
        if isGroup {
            if let g = groupAvatar {
                intent.setImage(INImage(imageData: g), forParameterNamed: \.speakableGroupName)
            }
        } else if let si = senderImage {
            intent.setImage(si, forParameterNamed: \.sender)
        }

        // The system shows the sender name itself → drop the "Sender: " prefix
        // that the classic group banner needs.
        let base = (best.mutableCopy() as? UNMutableNotificationContent) ?? best
        if isGroup, let pv = preview, !pv.isEmpty { base.body = pv }

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate { _ in
            // Donation failure must not block delivery; try the update anyway.
            do {
                let updated = try base.updating(from: intent)
                done(updated)
            } catch {
                done(nil)
            }
        }
    }

    private static func attachAvatarFallback(_ best: UNMutableNotificationContent, avatar: Data?) {
        guard best.attachments.isEmpty, let d = avatar else { return }
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(UUID().uuidString + ".png")
        do {
            try d.write(to: url)
            let att = try UNNotificationAttachment(identifier: "avatar", url: url, options: nil)
            best.attachments = [att]
        } catch {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Payload helpers

    /// Top-level userInfo merged with the Expo "body" (dictionary or JSON string).
    private static func payload(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in userInfo { if let ks = k as? String { out[ks] = v } }
        var nested: [String: Any]? = userInfo["body"] as? [String: Any]
        if nested == nil, let s = userInfo["body"] as? String, s.hasPrefix("{"),
           let d = s.data(using: .utf8),
           let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
            nested = j
        }
        if let n = nested { for (k, v) in n { out[k] = v } }
        return out
    }

    private static func str(_ p: [String: Any], _ k: String) -> String? {
        if let s = p[k] as? String { return s.isEmpty ? nil : s }
        if let n = p[k] as? NSNumber { return n.stringValue }
        return nil
    }

    private static func isTrue(_ s: String?) -> Bool {
        guard let s = s?.lowercased() else { return false }
        return s == "1" || s == "true"
    }

    private static func httpsURL(_ raw: String?) -> URL? {
        guard var s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        if s.hasPrefix("/") { s = "https://chatyy.com.br" + s }
        guard let u = URL(string: s), u.scheme?.lowercased() == "https" else { return nil }
        return u
    }

    // [2026-10-05] Delivered-on-receipt. d_ack = HMAC token scoped to
    // (msg, conversation, recipient, exp) — no secret embedded here.
    // [2026-10-07] Reads the MERGED payload: on the Expo route (all iOS
    // devices) d_ack lives inside the "body" dictionary, which the previous
    // string-only parser never saw.
    private static func reportDelivered(_ p: [String: Any]) {
        guard let dAck = str(p, "d_ack"),
              let url = URL(string: "https://chatyy.com.br/api/email.php?action=chat_push_delivered")
        else { return }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["d_ack": dAck])
        URLSession.shared.dataTask(with: req).resume()
    }

    // MARK: - Background message journal ([2026-10-07 bgsync])
    //
    // Same JSONL line format + flock protocol as the app side
    // (modules/expo-callkit/ios/ChatBgJournal.swift, Android ChatBgJournal.kt).
    // The NSE is a separate process: an exclusive flock on inbox.lock around the
    // append keeps it atomic w.r.t. the app's read/commit. Bounded (384 KB).
    private static let journalTypes: Set<String> = ["chat_message", "chat_mention", "chat_keyword"]

    private static func journalMessage(_ p: [String: Any]) {
        guard let type = str(p, "type"), journalTypes.contains(type),
              let cid = str(p, "conversation_id"), let mid = str(p, "message_id"),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.onemundo.mail")
        else { return }
        let locked = str(p, "locked") == "1"
        let full = str(p, "bg_full") == "1" && !locked
        let isGroup = isTrue(str(p, "is_group")) || str(p, "conversation_type") == "group"
        var o: [String: Any] = [
            "v": 1, "src": "nse",
            "acct": (str(p, "recipient_email") ?? "").lowercased(),
            "at": Int64(Date().timeIntervalSince1970 * 1000),
            "cid": cid, "mid": mid,
            "full": full ? "1" : "0", "locked": locked ? "1" : "0",
            "sender": str(p, "sender_email") ?? "",
            "type": str(p, "bg_type") ?? "",
            "preview": String((str(p, "msg_preview") ?? "").prefix(300)),
            "ts": str(p, "bg_ts") ?? "",
            "grp": isGroup ? "1" : "0",
            "unread": str(p, "unread_count") ?? "",
        ]
        if !locked {
            o["sname"] = str(p, "sender_name") ?? ""
            o["cname"] = str(p, "conversation_name") ?? str(p, "group_name") ?? ""
        }
        if full {
            let map: [(String, String)] = [("bg_text", "text"), ("bg_cmid", "cmid"), ("bg_furl", "furl"),
                                           ("bg_fname", "fname"), ("bg_fsize", "fsize"), ("bg_w", "w"),
                                           ("bg_h", "h"), ("bg_dur", "dur"), ("bg_thumb", "thumb"),
                                           ("bg_reply", "reply"), ("bg_rquote", "rquote")]
            for (src, dst) in map { if let v = str(p, src) { o[dst] = v } }
        }
        guard let d = try? JSONSerialization.data(withJSONObject: o),
              var line = String(data: d, encoding: .utf8), !line.contains("\n") else { return }
        line += "\n"
        let dir = container.appendingPathComponent("chatyy_bg_journal", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let fd = open(dir.appendingPathComponent("inbox.lock").path, O_RDWR | O_CREAT, 0o644)
        if fd < 0 { return }
        defer { close(fd) }
        if flock(fd, LOCK_EX) != 0 { return }
        defer { flock(fd, LOCK_UN) }
        let file = dir.appendingPathComponent("inbox.jsonl")
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        if size > 384 * 1024 { return }
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: nil)
        }
        guard let h = try? FileHandle(forWritingTo: file), let bytes = line.data(using: .utf8) else { return }
        _ = h.seekToEndOfFile()
        h.write(bytes)
        try? h.close()
    }

    private static func extractImageURL(from p: [String: Any]) -> URL? {
        var candidates: [String] = []
        if let s = p["media_url"] as? String { candidates.append(s) }
        if let fcm = p["fcm_options"] as? [String: Any], let s = fcm["image"] as? String { candidates.append(s) }
        if let s = p["image"] as? String { candidates.append(s) }
        for raw in candidates {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
               scheme == "https" || scheme == "http" {
                return url
            }
        }
        return nil
    }

    // MARK: - Downloads

    /// Media → temp FILE (streamed, never decoded in memory) → attachment.
    private static func downloadAttachment(_ url: URL, completion: @escaping (UNNotificationAttachment?) -> Void) -> URLSessionTask {
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: downloadTimeout)
        let task = URLSession.shared.downloadTask(with: req) { location, response, _ in
            guard let location = location else { completion(nil); return }
            completion(makeAttachment(from: location, response: response, url: url))
        }
        task.resume()
        return task
    }

    /// Avatar → 256 px PNG data, cached 24 h in the extension's Caches dir.
    /// Returns nil task when served from cache.
    private static func loadAvatar(_ url: URL, completion: @escaping (Data?) -> Void) -> URLSessionTask? {
        let cacheFile = avatarCacheFile(for: url)
        if let f = cacheFile,
           let attrs = try? FileManager.default.attributesOfItem(atPath: f.path),
           let mod = attrs[.modificationDate] as? Date,
           Date().timeIntervalSince(mod) < 24 * 3600,
           let d = try? Data(contentsOf: f) {
            completion(d)
            return nil
        }
        let req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: downloadTimeout)
        let task = URLSession.shared.dataTask(with: req) { data, response, _ in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard let data = data, (200..<300).contains(code), data.count <= maxAvatarBytes,
                  let png = downsampledPNG(data, maxPixel: 256) else {
                // Stale cache beats nothing.
                if let f = cacheFile, let d = try? Data(contentsOf: f) { completion(d) } else { completion(nil) }
                return
            }
            if let f = cacheFile { try? png.write(to: f, options: .atomic) }
            completion(png)
        }
        task.resume()
        return task
    }

    private static func avatarCacheFile(for url: URL) -> URL? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let dir = caches.appendingPathComponent("chat_avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent(name + ".png")
    }

    /// ImageIO thumbnail — decodes straight to the target size (no full-size
    /// bitmap in memory, keeps the NSE far below its memory ceiling).
    private static func downsampledPNG(_ data: Data, maxPixel: Int) -> Data? {
        let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let src = CGImageSourceCreateWithData(data as CFData, srcOpts) else { return nil }
        let thumbOpts = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, thumbOpts) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, "public.png" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    private static func makeAttachment(from location: URL, response: URLResponse?, url: URL) -> UNNotificationAttachment? {
        let ext = fileExtension(url: url, response: response)
        let fileName = UUID().uuidString + (ext.isEmpty ? "" : "." + ext)
        let dest = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(fileName)
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: location, to: dest)
            return try UNNotificationAttachment(identifier: fileName, url: dest, options: nil)
        } catch {
            try? FileManager.default.removeItem(at: dest)
            return nil
        }
    }

    private static func fileExtension(url: URL, response: URLResponse?) -> String {
        let pathExt = url.pathExtension
        if !pathExt.isEmpty, pathExt.count <= 5 { return pathExt }
        switch response?.mimeType?.lowercased() {
        case "image/jpeg": return "jpg"
        case "image/png":  return "png"
        case "image/gif":  return "gif"
        case "image/webp": return "webp"
        case "image/heic": return "heic"
        default:           return "jpg"
        }
    }
}
