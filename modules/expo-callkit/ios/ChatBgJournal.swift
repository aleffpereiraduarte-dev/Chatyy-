import Foundation
import BackgroundTasks

/// [2026-10-07 bgsync] Background message journal (iOS, app side).
///
/// WhatsApp model: the Notification Service Extension (separate process) writes
/// every incoming chat message into a small JSONL journal inside the App Group
/// container; a BGAppRefreshTask tops it up with `chat_sync` when no push came
/// (muted chat, DND, throttled pushes). The JS app (services/bgJournal.js)
/// merges the journal into its expo-sqlite store synchronously BEFORE the chat
/// list's first read, so opening the app shows the message with no loading.
/// The normal WS resume + delta sync reconciles afterwards (journal is an
/// accelerator, never the source of truth).
///
/// Cross-process safety: NSE and app both take an exclusive `flock` on
/// `inbox.lock` around every append/read/commit (held for microseconds — never
/// across a suspension point, so no 0xdead10cc). The NSE writer is a copy of
/// `append` in plugins/notification-service/NotificationService.swift — keep
/// the line format identical (see ChatBgJournal.kt for the field list).
///
/// Without the App Group on the NSE profile the extension simply can't write
/// (containerURL == nil) → behaviour = today's (the sync fetches on open).
enum ChatBgJournal {
    static let appGroupId = "group.com.onemundo.mail"
    static let refreshTaskId = "com.onemundo.mail.chat.refresh"
    private static let maxBytes = 384 * 1024
    private static let cfgKey = "bg_sync_cfg"
    private static let enabledKey = "bg_sync_enabled"

    private static func dir() -> URL? {
        guard let c = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else { return nil }
        let d = c.appendingPathComponent("chatyy_bg_journal", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// Run `body` holding the cross-process journal lock. Returns nil when the
    /// container is unavailable or the lock can't be taken.
    private static func withLock<T>(_ body: (URL) -> T) -> T? {
        guard let d = dir() else { return nil }
        let lockPath = d.appendingPathComponent("inbox.lock").path
        let fd = open(lockPath, O_RDWR | O_CREAT, 0o644)
        if fd < 0 { return nil }
        defer { close(fd) }
        if flock(fd, LOCK_EX) != 0 { return nil }
        defer { flock(fd, LOCK_UN) }
        return body(d.appendingPathComponent("inbox.jsonl"))
    }

    @discardableResult
    static func append(_ lines: [String]) -> Int {
        let clean = lines.filter { !$0.isEmpty && !$0.contains("\n") }
        if clean.isEmpty { return 0 }
        return withLock { file -> Int in
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
            if size > maxBytes { return 0 }
            guard let data = (clean.joined(separator: "\n") + "\n").data(using: .utf8) else { return 0 }
            if !FileManager.default.fileExists(atPath: file.path) {
                FileManager.default.createFile(atPath: file.path, contents: nil)
            }
            guard let h = try? FileHandle(forWritingTo: file) else { return 0 }
            defer { try? h.close() }
            _ = h.seekToEndOfFile()
            h.write(data)
            return clean.count
        } ?? 0
    }

    /// (text, byteLength). JS commits by passing the byte length back.
    static func read() -> (String, Int) {
        return withLock { file -> (String, Int) in
            guard let d = try? Data(contentsOf: file), !d.isEmpty else { return ("", 0) }
            return (String(decoding: d, as: UTF8.self), d.count)
        } ?? ("", 0)
    }

    /// Drop the first `consumed` bytes, keep `keep` (lines JS retains) + anything
    /// appended after the read. Atomic write.
    @discardableResult
    static func commit(consumed: Int, keep: String) -> Bool {
        return withLock { file -> Bool in
            let all = (try? Data(contentsOf: file)) ?? Data()
            let cut = max(0, min(consumed, all.count))
            let tail = all.subdata(in: cut..<all.count)
            var head = Data()
            if !keep.isEmpty {
                head = (keep.hasSuffix("\n") ? keep : keep + "\n").data(using: .utf8) ?? Data()
            }
            if head.isEmpty && tail.isEmpty {
                try? FileManager.default.removeItem(at: file)
                return true
            }
            do { try (head + tail).write(to: file, options: .atomic); return true } catch { return false }
        } ?? false
    }

    static func clear() {
        _ = withLock { file in try? FileManager.default.removeItem(at: file) }
        UserDefaults(suiteName: appGroupId)?.removeObject(forKey: cfgKey)
    }

    // MARK: - Background refresh (BGAppRefreshTask)

    /// JS → native: {acct, convs:[{id, pts}]}; pts merged with max() against
    /// what the refresh task already advanced.
    static func configure(_ json: String) {
        guard let ud = UserDefaults(suiteName: appGroupId),
              let d = json.data(using: .utf8),
              let incoming = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return }
        let acct = ((incoming["acct"] as? String) ?? "").lowercased()
        var prevPts: [String: Int64] = [:]
        if let prev = ud.dictionary(forKey: cfgKey), ((prev["acct"] as? String) ?? "") == acct,
           let pc = prev["convs"] as? [[String: Any]] {
            for c in pc { if let id = c["id"] as? String { prevPts[id] = (c["pts"] as? NSNumber)?.int64Value ?? 0 } }
        }
        var out: [[String: Any]] = []
        for c in ((incoming["convs"] as? [[String: Any]]) ?? []).prefix(60) {
            let id: String = (c["id"] as? String) ?? ((c["id"] as? NSNumber)?.stringValue ?? "")
            if id.isEmpty { continue }
            let pts = max((c["pts"] as? NSNumber)?.int64Value ?? 0, prevPts[id] ?? 0)
            out.append(["id": id, "pts": NSNumber(value: pts)])
        }
        ud.set(["acct": acct, "convs": out], forKey: cfgKey)
    }

    static func setEnabled(_ on: Bool) {
        UserDefaults(suiteName: appGroupId)?.set(on, forKey: enabledKey)
        if on { scheduleRefresh() } else {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: refreshTaskId)
        }
    }

    static func isEnabled() -> Bool {
        return UserDefaults(suiteName: appGroupId)?.bool(forKey: enabledKey) ?? false
    }

    static func scheduleRefresh() {
        guard isEnabled() else { return }
        let req = BGAppRefreshTaskRequest(identifier: refreshTaskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(req) } catch {
            NSLog("[ChatBgJournal] submit refresh failed: \(error.localizedDescription)")
        }
    }

    /// BGAppRefreshTask handler. iOS gives ~30 s; we bound the request to 20 s.
    static func handleRefresh(_ task: BGAppRefreshTask) {
        scheduleRefresh() // keep the chain alive regardless of outcome
        let session = URLSession(configuration: .ephemeral)
        task.expirationHandler = { session.invalidateAndCancel() }
        runSync(session: session) { ok in task.setTaskCompleted(success: ok) }
    }

    static func runSync(session: URLSession, done: @escaping (Bool) -> Void) {
        guard let ud = UserDefaults(suiteName: appGroupId),
              let cfg = ud.dictionary(forKey: cfgKey),
              let acct = cfg["acct"] as? String, !acct.isEmpty,
              let convs = cfg["convs"] as? [[String: Any]], !convs.isEmpty,
              let bearer = ud.string(forKey: "auth_token"), !bearer.isEmpty else { done(true); return }
        var base = ud.string(forKey: "api_base") ?? "https://chatyy.com.br"
        if !base.hasPrefix("https://") { base = "https://chatyy.com.br" }
        while base.hasSuffix("/") { base.removeLast() }
        let reqConvs: [[String: Any]] = convs.compactMap { c in
            guard let id = Int64((c["id"] as? String) ?? "") else { return nil }
            return ["id": NSNumber(value: id), "since_pts": (c["pts"] as? NSNumber) ?? NSNumber(value: 0), "limit": NSNumber(value: 50)]
        }
        guard let url = URL(string: base + "/api/email.php?action=chat_sync"),
              let body = try? JSONSerialization.data(withJSONObject: ["conversations": reqConvs]) else { done(true); return }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        req.httpBody = body
        session.dataTask(with: req) { data, resp, err in
            guard err == nil, let data = data,
                  let code = (resp as? HTTPURLResponse)?.statusCode, (200..<300).contains(code),
                  let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  (j["success"] as? Bool) == true,
                  let out = (j["data"] as? [String: Any])?["conversations"] as? [[String: Any]] else {
                done(false); return
            }
            var lines: [String] = []
            var newPts: [String: Int64] = [:]
            var acks: [Int64: [Int64]] = [:]
            for c in out {
                if (c["denied"] as? Bool) == true { continue }
                let cid = (c["id"] as? NSNumber)?.stringValue ?? ((c["id"] as? String) ?? "")
                if cid.isEmpty { continue }
                var hydrated = Set<Int64>()
                for m in (c["messages"] as? [[String: Any]]) ?? [] {
                    guard let mid = int64(m["id"]), mid > 0 else { continue }
                    hydrated.insert(mid)
                    if let l = lineFromSyncRow(acct: acct, cid: cid, m: m) { lines.append(l) }
                    let sender = ((m["sender_email"] as? String) ?? "").lowercased()
                    if !sender.isEmpty && sender != acct, let c64 = Int64(cid) { acks[c64, default: []].append(mid) }
                }
                var evMax: Int64 = 0
                var gap = false
                for e in (c["events"] as? [[String: Any]]) ?? [] {
                    evMax = max(evMax, int64(e["pts"]) ?? 0)
                    if (e["type"] as? String) == "new_message",
                       let pmid = int64((e["payload"] as? [String: Any])?["message_id"]), pmid > 0,
                       !hydrated.contains(pmid) { gap = true }
                }
                if !gap {
                    let wm = ((c["has_more"] as? Bool) == true) ? evMax : (int64(c["latest_pts"]) ?? 0)
                    if wm > 0 { newPts[cid] = wm }
                }
            }
            if !lines.isEmpty { append(lines) }
            advance(acct: acct, pts: newPts)
            for (cid, ids) in acks {
                guard let u = URL(string: base + "/api/email.php?action=chat_delivery_ack"),
                      let b = try? JSONSerialization.data(withJSONObject: ["conversation_id": NSNumber(value: cid),
                                                                           "message_ids": ids.prefix(100).map { NSNumber(value: $0) }]) else { continue }
                var r = URLRequest(url: u, timeoutInterval: 8)
                r.httpMethod = "POST"
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
                r.httpBody = b
                session.dataTask(with: r).resume()
            }
            done(true)
        }.resume()
    }

    private static func advance(acct: String, pts: [String: Int64]) {
        guard !pts.isEmpty, let ud = UserDefaults(suiteName: appGroupId),
              var cfg = ud.dictionary(forKey: cfgKey), (cfg["acct"] as? String) == acct,
              var convs = cfg["convs"] as? [[String: Any]] else { return }
        for i in convs.indices {
            guard let id = convs[i]["id"] as? String, let p = pts[id] else { continue }
            if p > ((convs[i]["pts"] as? NSNumber)?.int64Value ?? 0) { convs[i]["pts"] = NSNumber(value: p) }
        }
        cfg["convs"] = convs
        ud.set(cfg, forKey: cfgKey)
    }

    private static func int64(_ v: Any?) -> Int64? {
        if let n = v as? NSNumber { return n.int64Value }
        if let s = v as? String { return Int64(s) }
        return nil
    }

    private static func str(_ m: [String: Any], _ k: String) -> String {
        if let s = m[k] as? String { return s }
        if let n = m[k] as? NSNumber { return n.stringValue }
        return ""
    }

    /// Same line format as ChatBgJournal.kt lineFromSyncRow.
    static func lineFromSyncRow(acct: String, cid: String, m: [String: Any]) -> String? {
        guard let mid = int64(m["id"]) else { return nil }
        if !str(m, "deleted_at").isEmpty { return nil }
        let content = str(m, "content")
        let sealed = (m["sealed_sender"] as? Bool) == true || str(m, "sealed_sender") == "t"
        let viewOnce = (m["is_view_once"] as? Bool) == true || str(m, "is_view_once") == "t"
        let full = !(sealed || viewOnce || content.hasPrefix("{\"e2e\""))
        var o: [String: Any] = [
            "v": 1, "src": "bg", "acct": acct, "at": Int64(Date().timeIntervalSince1970 * 1000),
            "cid": cid, "mid": String(mid), "full": full ? "1" : "0", "locked": "0",
            "sender": str(m, "sender_email"), "type": str(m, "type").isEmpty ? "text" : str(m, "type"),
            "ts": str(m, "created_at"),
        ]
        if full {
            o["text"] = content
            let map: [(String, String)] = [("client_message_id", "cmid"), ("file_url", "furl"), ("file_name", "fname"),
                                           ("file_size", "fsize"), ("image_width", "w"), ("image_height", "h"),
                                           ("duration", "dur"), ("thumbnail_url", "thumb"), ("reply_to_id", "reply")]
            for (src, dst) in map {
                let v = str(m, src)
                if !v.isEmpty && v != "0" { o[dst] = v }
            }
            let rq = str(m, "reply_quote_text")
            if !rq.isEmpty && !rq.hasPrefix("{\"e2e\"") { o["rquote"] = String(rq.prefix(100)) }
        }
        guard let d = try? JSONSerialization.data(withJSONObject: o),
              let s = String(data: d, encoding: .utf8) else { return nil }
        return s
    }
}
