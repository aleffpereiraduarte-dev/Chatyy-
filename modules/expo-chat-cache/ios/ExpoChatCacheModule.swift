import ExpoModulesCore
import Foundation
import SQLite3
import CommonCrypto

/// ExpoChatCacheModule
///
/// Native chat message cache backed by SQLite + an in-memory layer.
/// The whole point is to expose a TRULY SYNCHRONOUS read so the JS chat
/// screen can populate `useState` initializer with cached messages on the
/// very first render — no flicker, no async gap.
///
/// Architecture:
///   - SQLite file: <Caches>/chatyy_chat_cache.sqlite
///   - In-memory cache: [conversationId: [Message]]  (most-recent N per chat)
///   - Writes go to both layers (memory first for instant read-after-write)
///
/// Why not use expo-sqlite? expo-sqlite calls go through the JS bridge
/// asynchronously (Promises). The whole problem we're solving is the
/// async gap between mount and first render. So we read SQLite directly
/// in Swift on the calling thread and return data synchronously.

private let DB_NAME = "chatyy_chat_cache.sqlite"
private let DEFAULT_LIMIT = 50
private let MEMORY_CACHE_SIZE = 100 // messages kept in memory per conversation

public class ExpoChatCacheModule: Module {

    private var db: OpaquePointer?
    /// LOCK ORDERING: Always acquire dbLock before memLock, never the reverse.
    /// All code paths must release dbLock before acquiring memLock (use do-blocks
    /// to scope the defer). This prevents ABBA deadlocks.
    private let dbLock = NSLock()
    // In-memory cache: conversationId -> sorted [Message] (ascending by id)
    private var memCache: [Int: [[String: Any]]] = [:]
    // Conversation list (single sorted snapshot, mirrors the chat list tab)
    private var convCache: [[String: Any]]?
    // Media URI cache: remote URL -> absolute file path on disk
    private var mediaCache: [String: String] = [:]
    // Email cache: folder name -> sorted [Email] (newest first)
    private var emailCache: [String: [[String: Any]]] = [:]
    // Drive cache: parentId -> sorted [DriveFile]
    private var driveCache: [Int: [[String: Any]]] = [:]
    // Avatar cache: email -> absolute local file path
    private var avatarCache: [String: String] = [:]
    private let memLock = NSLock()

    deinit {
        if let db = db { sqlite3_close_v2(db) }
    }

    // Disk directory for downloaded chat media (videos, images, audio)
    private lazy var mediaCacheDir: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("chat-media", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // Disk directory for cached avatars
    private lazy var avatarCacheDir: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    public func definition() -> ModuleDefinition {
        Name("ExpoChatCacheModule")

        OnCreate {
            self.openDatabase()
            self.createSchema()
        }

        // ─── SYNCHRONOUS reads (the whole point of this module) ───
        Function("getCachedMessagesSync") { (conversationId: Int, limit: Int?) -> [[String: Any]] in
            let n = limit ?? DEFAULT_LIMIT

            // Memory layer first
            self.memLock.lock()
            if let cached = self.memCache[conversationId], !cached.isEmpty {
                let slice = Array(cached.suffix(n))
                self.memLock.unlock()
                return slice
            }
            self.memLock.unlock()

            // Fall back to SQLite (still synchronous, just one disk read)
            let rows = self.queryMessages(conversationId: conversationId, limit: n)
            // Populate memory cache so the next call is even faster
            if !rows.isEmpty {
                self.memLock.lock()
                self.memCache[conversationId] = rows
                self.memLock.unlock()
            }
            return rows
        }

        Function("getLastSyncIdSync") { (conversationId: Int) -> Int in
            // Try memory first
            self.memLock.lock()
            if let cached = self.memCache[conversationId], let last = cached.last,
               let id = last["id"] as? Int {
                self.memLock.unlock()
                return id
            }
            self.memLock.unlock()
            return self.queryMaxId(conversationId: conversationId)
        }

        // ─── Writes (async since they can run in background) ───
        AsyncFunction("saveMessage") { (conversationId: Int, message: [String: Any]) -> Void in
            self.upsertMessages(conversationId: conversationId, messages: [message])
            self.mergeIntoMemoryCache(conversationId: conversationId, messages: [message])
        }

        AsyncFunction("saveMessages") { (conversationId: Int, messages: [[String: Any]]) -> Void in
            guard !messages.isEmpty else { return }
            self.upsertMessages(conversationId: conversationId, messages: messages)
            self.mergeIntoMemoryCache(conversationId: conversationId, messages: messages)
        }

        AsyncFunction("warmCache") { (conversationId: Int) -> Void in
            // Pre-load into memory so the next sync read is instant
            let rows = self.queryMessages(conversationId: conversationId, limit: MEMORY_CACHE_SIZE)
            self.memLock.lock()
            self.memCache[conversationId] = rows
            self.memLock.unlock()
        }

        AsyncFunction("deleteMessage") { (conversationId: Int, messageId: Int) -> Void in
            do {
                self.dbLock.lock()
                defer { self.dbLock.unlock() }
                let sql = "DELETE FROM messages WHERE conversation_id = ? AND id = ?;"
                var stmt: OpaquePointer?
                if sqlite3_prepare_v2(self.db, sql, -1, &stmt, nil) == SQLITE_OK {
                    sqlite3_bind_int64(stmt, 1, Int64(conversationId))
                    sqlite3_bind_int64(stmt, 2, Int64(messageId))
                    sqlite3_step(stmt)
                }
                sqlite3_finalize(stmt)
            }
            // Invalidate memory cache so deleted message doesn't reappear
            do {
                self.memLock.lock()
                defer { self.memLock.unlock() }
                self.memCache[conversationId]?.removeAll { ($0["id"] as? Int) == messageId }
            }
        }

        AsyncFunction("clearConversation") { (conversationId: Int) -> Void in
            // BUG 11 FIX: Use do-blocks to enforce lock ordering (release
            // dbLock before acquiring memLock, same pattern as deleteMessage).
            do {
                self.dbLock.lock()
                defer { self.dbLock.unlock() }
                let sql = "DELETE FROM messages WHERE conversation_id = ?;"
                var stmt: OpaquePointer?
                if sqlite3_prepare_v2(self.db, sql, -1, &stmt, nil) == SQLITE_OK {
                    sqlite3_bind_int64(stmt, 1, Int64(conversationId))
                    sqlite3_step(stmt)
                }
                sqlite3_finalize(stmt)
            }
            do {
                self.memLock.lock()
                defer { self.memLock.unlock() }
                self.memCache[conversationId] = nil
            }
        }

        AsyncFunction("clearAll") { () -> Void in
            do {
                self.dbLock.lock()
                defer { self.dbLock.unlock() }
                sqlite3_exec(self.db, "DELETE FROM messages;", nil, nil, nil)
                sqlite3_exec(self.db, "DELETE FROM conversations;", nil, nil, nil)
                sqlite3_exec(self.db, "DELETE FROM media_uris;", nil, nil, nil)
                sqlite3_exec(self.db, "DELETE FROM emails;", nil, nil, nil)
                sqlite3_exec(self.db, "DELETE FROM drive_files;", nil, nil, nil)
                sqlite3_exec(self.db, "DELETE FROM avatars;", nil, nil, nil)
                sqlite3_exec(self.db, "DELETE FROM emails_fts;", nil, nil, nil)
            }
            do {
                self.memLock.lock()
                defer { self.memLock.unlock() }
                self.memCache.removeAll()
                self.convCache = nil
                self.mediaCache.removeAll()
                self.emailCache.removeAll()
                self.driveCache.removeAll()
                self.avatarCache.removeAll()
            }
        }

        // ─── Conversation list (chat tab) ─────────────────────────────
        Function("getCachedConversationsSync") { () -> [[String: Any]] in
            self.memLock.lock()
            if let cached = self.convCache {
                self.memLock.unlock()
                return cached
            }
            self.memLock.unlock()
            let rows = self.queryConversations()
            self.memLock.lock()
            self.convCache = rows
            self.memLock.unlock()
            return rows
        }

        AsyncFunction("saveConversations") { (conversations: [[String: Any]]) -> Void in
            self.upsertConversations(conversations: conversations, replaceAll: true)
            self.memLock.lock()
            self.convCache = self.sortedConversations(conversations)
            self.memLock.unlock()
        }

        AsyncFunction("updateConversation") { (conversation: [String: Any]) -> Void in
            self.upsertConversations(conversations: [conversation], replaceAll: false)
            // Read base from memory WITHOUT holding lock during DB query (avoids deadlock)
            self.memLock.lock()
            let base = self.convCache
            self.memLock.unlock()
            var current = base ?? self.queryConversations()
            if let id = conversation["id"] as? Int {
                current.removeAll { ($0["id"] as? Int) == id }
                current.append(conversation)
            }
            self.memLock.lock()
            self.convCache = self.sortedConversations(current)
            self.memLock.unlock()
        }

        AsyncFunction("clearConversations") { () -> Void in
            self.dbLock.lock()
            defer { self.dbLock.unlock() }
            sqlite3_exec(self.db, "DELETE FROM conversations;", nil, nil, nil)
            self.memLock.lock()
            self.convCache = nil
            self.memLock.unlock()
        }

        // ─── Media URI cache (remote URL → local file://) ─────────────
        Function("getLocalUriSync") { (remoteUrl: String) -> String? in
            self.memLock.lock()
            if let cached = self.mediaCache[remoteUrl] {
                self.memLock.unlock()
                // Verify file still exists (could have been evicted)
                if FileManager.default.fileExists(atPath: cached) {
                    return "file://" + cached
                }
                self.memLock.lock()
                self.mediaCache.removeValue(forKey: remoteUrl)
                self.memLock.unlock()
                return nil
            }
            self.memLock.unlock()
            // Disk lookup
            if let path = self.queryMediaPath(remoteUrl: remoteUrl),
               FileManager.default.fileExists(atPath: path) {
                self.memLock.lock()
                self.mediaCache[remoteUrl] = path
                self.memLock.unlock()
                return "file://" + path
            }
            return nil
        }

        AsyncFunction("prefetchMedia") { (remoteUrl: String) -> Void in
            // Already cached and file exists? skip.
            if let path = self.queryMediaPath(remoteUrl: remoteUrl),
               FileManager.default.fileExists(atPath: path) { return }
            await self.downloadMedia(remoteUrl: remoteUrl)
        }

        AsyncFunction("registerLocalMedia") { (remoteUrl: String, localPath: String) -> Void in
            // Strip file:// prefix if present
            let path = localPath.hasPrefix("file://")
                ? String(localPath.dropFirst("file://".count))
                : localPath
            let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.intValue ?? 0
            self.upsertMediaPath(remoteUrl: remoteUrl, localPath: path, size: size)
            self.memLock.lock()
            self.mediaCache[remoteUrl] = path
            self.memLock.unlock()
        }

        AsyncFunction("getMediaCacheSize") { () -> Int in
            self.dbLock.lock()
            defer { self.dbLock.unlock() }
            var total = 0
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(self.db, "SELECT SUM(file_size) FROM media_uris;", -1, &stmt, nil) == SQLITE_OK {
                if sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) != SQLITE_NULL {
                    total = Int(sqlite3_column_int64(stmt, 0))
                }
            }
            sqlite3_finalize(stmt)
            return total
        }

        // ─── Email list cache (inbox/folders) ─────────────────────────
        Function("getCachedEmailsSync") { (folder: String, limit: Int?) -> [[String: Any]] in
            let n = limit ?? 50
            self.memLock.lock()
            if let cached = self.emailCache[folder], !cached.isEmpty {
                let slice = Array(cached.prefix(n))
                self.memLock.unlock()
                return slice
            }
            self.memLock.unlock()
            let rows = self.queryEmails(folder: folder, limit: n)
            if !rows.isEmpty {
                self.memLock.lock()
                self.emailCache[folder] = rows
                self.memLock.unlock()
            }
            return rows
        }

        AsyncFunction("saveEmails") { (folder: String, emails: [[String: Any]]) -> Void in
            guard !emails.isEmpty else { return }
            self.upsertEmails(folder: folder, emails: emails)
            self.memLock.lock()
            // Replace the in-memory snapshot with the freshest data (server is authoritative)
            self.emailCache[folder] = emails
            self.memLock.unlock()
        }

        AsyncFunction("clearFolder") { (folder: String) -> Void in
            do {
                self.dbLock.lock()
                defer { self.dbLock.unlock() }
                let sql = "DELETE FROM emails WHERE folder = ?;"
                var stmt: OpaquePointer?
                if sqlite3_prepare_v2(self.db, sql, -1, &stmt, nil) == SQLITE_OK {
                    sqlite3_bind_text(stmt, 1, (folder as NSString).utf8String, -1,
                                      unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                    sqlite3_step(stmt)
                }
                sqlite3_finalize(stmt)
            }
            do {
                self.memLock.lock()
                defer { self.memLock.unlock() }
                self.emailCache[folder] = nil
            }
        }

        // ─── Drive/files list cache ───────────────────────────────────
        Function("getCachedDriveFilesSync") { (parentId: Int, limit: Int?) -> [[String: Any]] in
            let n = limit ?? 200
            self.memLock.lock()
            if let cached = self.driveCache[parentId], !cached.isEmpty {
                let slice = Array(cached.prefix(n))
                self.memLock.unlock()
                return slice
            }
            self.memLock.unlock()
            let rows = self.queryDriveFiles(parentId: parentId, limit: n)
            if !rows.isEmpty {
                self.memLock.lock()
                self.driveCache[parentId] = rows
                self.memLock.unlock()
            }
            return rows
        }

        AsyncFunction("saveDriveFiles") { (parentId: Int, files: [[String: Any]]) -> Void in
            self.upsertDriveFiles(parentId: parentId, files: files)
            self.memLock.lock()
            self.driveCache[parentId] = files
            self.memLock.unlock()
        }

        // ─── Avatar cache (per email) ─────────────────────────────────
        Function("getAvatarLocalUriSync") { (email: String) -> String? in
            self.memLock.lock()
            if let path = self.avatarCache[email], FileManager.default.fileExists(atPath: path) {
                self.memLock.unlock()
                return "file://" + path
            }
            self.memLock.unlock()
            if let path = self.queryAvatarPath(email: email),
               FileManager.default.fileExists(atPath: path) {
                self.memLock.lock()
                self.avatarCache[email] = path
                self.memLock.unlock()
                return "file://" + path
            }
            return nil
        }

        AsyncFunction("prefetchAvatar") { (email: String, remoteUrl: String) -> Void in
            if let path = self.queryAvatarPath(email: email),
               FileManager.default.fileExists(atPath: path) { return }
            await self.downloadAvatar(email: email, remoteUrl: remoteUrl)
        }

        // ─── FTS5 search ────────────────────────────────────────────────
        Function("searchMessagesSync") { (query: String, limit: Int?) -> [[String: Any]] in
            return self.searchMessages(query: query, limit: limit ?? 50)
        }

        Function("searchEmailsSync") { (query: String, folder: String?, limit: Int?) -> [[String: Any]] in
            return self.searchEmails(query: query, folder: folder, limit: limit ?? 50)
        }

        AsyncFunction("indexEmailForSearch") { (uid: Int, folder: String, subject: String, body: String, fromAddr: String) -> Void in
            self.dbLock.lock()
            defer { self.dbLock.unlock() }
            let sql = "INSERT INTO emails_fts(rowid, subject, body, from_addr) VALUES (?, ?, ?, ?);"
            var stmt: OpaquePointer?
            if sqlite3_prepare_v2(self.db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int64(stmt, 1, Int64(uid))
                self.bindString(stmt, 2, subject)
                self.bindString(stmt, 3, body)
                self.bindString(stmt, 4, fromAddr)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }

        AsyncFunction("clearMediaCache") { () -> Void in
            // Wipe disk files first
            let dir = self.mediaCacheDir
            if FileManager.default.fileExists(atPath: dir.path) {
                try? FileManager.default.removeItem(at: dir)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            self.dbLock.lock()
            sqlite3_exec(self.db, "DELETE FROM media_uris;", nil, nil, nil)
            self.dbLock.unlock()
            self.memLock.lock()
            self.mediaCache.removeAll()
            self.memLock.unlock()
        }
    }

    // ─── SQLite plumbing ──────────────────────────────────────────

    private func openDatabase() {
        guard let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let dbPath = cachesDir.appendingPathComponent(DB_NAME).path
        if sqlite3_open(dbPath, &db) != SQLITE_OK {
            print("[ChatCache] Failed to open db at \(dbPath)")
            db = nil
            return
        }
        // WAL = better concurrent reads/writes
        sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA synchronous=NORMAL;", nil, nil, nil)
        // Prevent SQLITE_BUSY by waiting up to 5s for locks to clear
        sqlite3_exec(db, "PRAGMA busy_timeout = 5000;", nil, nil, nil)
    }

    private func createSchema() {
        let sql = """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                sender_email TEXT,
                content TEXT,
                type TEXT,
                file_url TEXT,
                file_name TEXT,
                file_size INTEGER,
                created_at TEXT,
                edited_at TEXT,
                deleted_at TEXT,
                reply_to_id INTEGER,
                reactions_json TEXT,
                payload_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages(conversation_id, id DESC);

            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY,
                last_timestamp TEXT,
                payload_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_conversations_ts ON conversations(last_timestamp DESC);

            CREATE TABLE IF NOT EXISTS media_uris (
                remote_url TEXT PRIMARY KEY,
                local_path TEXT NOT NULL,
                file_size INTEGER,
                cached_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS emails (
                uid INTEGER NOT NULL,
                folder TEXT NOT NULL,
                sort_date TEXT,
                payload_json TEXT,
                PRIMARY KEY (uid, folder)
            );
            CREATE INDEX IF NOT EXISTS idx_emails_folder_date ON emails(folder, sort_date DESC);

            CREATE TABLE IF NOT EXISTS drive_files (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL,
                sort_name TEXT,
                payload_json TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_files(parent_id, sort_name);

            CREATE TABLE IF NOT EXISTS avatars (
                email TEXT PRIMARY KEY,
                local_path TEXT NOT NULL,
                cached_at INTEGER
            );

            -- FTS5 virtual tables for instant search across messages and emails.
            -- These are populated by triggers below so they stay in sync.
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content, sender_email,
                content='messages', content_rowid='id',
                tokenize='unicode61 remove_diacritics 2'
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
                subject, body, from_addr,
                tokenize='unicode61 remove_diacritics 2'
            );

            -- Sync triggers for messages → messages_fts
            CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content, sender_email)
                VALUES (new.id, new.content, new.sender_email);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content, sender_email)
                VALUES('delete', old.id, old.content, old.sender_email);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content, sender_email)
                VALUES('delete', old.id, old.content, old.sender_email);
                INSERT INTO messages_fts(rowid, content, sender_email)
                VALUES (new.id, new.content, new.sender_email);
            END;
        """
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    private func queryMessages(conversationId: Int, limit: Int) -> [[String: Any]] {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return [] }

        // Order by id ASC so the result matches what the JS layer expects
        // (oldest → newest). We fetch the LATEST N then reverse them.
        let sql = """
            SELECT id, conversation_id, sender_email, content, type,
                   file_url, file_name, file_size, created_at,
                   edited_at, deleted_at, reply_to_id, reactions_json, payload_json
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT ?;
        """
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_int64(stmt, 1, Int64(conversationId))
            sqlite3_bind_int(stmt, 2, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                var row: [String: Any] = [:]

                // If we stored the full payload_json (col 13), prefer that —
                // it preserves any extra fields the JS message had.
                if let cstr = sqlite3_column_text(stmt, 13) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                        continue
                    }
                }

                row["id"] = Int(sqlite3_column_int64(stmt, 0))
                row["conversation_id"] = Int(sqlite3_column_int64(stmt, 1))
                if let cstr = sqlite3_column_text(stmt, 2) { row["sender_email"] = String(cString: cstr) }
                if let cstr = sqlite3_column_text(stmt, 3) { row["content"] = String(cString: cstr) }
                if let cstr = sqlite3_column_text(stmt, 4) { row["type"] = String(cString: cstr) }
                if let cstr = sqlite3_column_text(stmt, 5) { row["file_url"] = String(cString: cstr) }
                if let cstr = sqlite3_column_text(stmt, 6) { row["file_name"] = String(cString: cstr) }
                if sqlite3_column_type(stmt, 7) != SQLITE_NULL {
                    row["file_size"] = Int(sqlite3_column_int64(stmt, 7))
                }
                if let cstr = sqlite3_column_text(stmt, 8) { row["created_at"] = String(cString: cstr) }
                if let cstr = sqlite3_column_text(stmt, 9) { row["edited_at"] = String(cString: cstr) }
                if let cstr = sqlite3_column_text(stmt, 10) { row["deleted_at"] = String(cString: cstr) }
                if sqlite3_column_type(stmt, 11) != SQLITE_NULL {
                    row["reply_to_id"] = Int(sqlite3_column_int64(stmt, 11))
                }
                if let cstr = sqlite3_column_text(stmt, 12) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) {
                        row["reactions"] = parsed
                    }
                }
                results.append(row)
            }
        }
        sqlite3_finalize(stmt)
        // We fetched DESC then reverse to get ASC (oldest → newest) which is what
        // the chat conversation screen expects.
        return results.reversed()
    }

    private func queryMaxId(conversationId: Int) -> Int {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return 0 }
        let sql = "SELECT MAX(id) FROM messages WHERE conversation_id = ?;"
        var stmt: OpaquePointer?
        var maxId = 0
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_int64(stmt, 1, Int64(conversationId))
            if sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_type(stmt, 0) != SQLITE_NULL {
                maxId = Int(sqlite3_column_int64(stmt, 0))
            }
        }
        sqlite3_finalize(stmt)
        return maxId
    }

    private func upsertMessages(conversationId: Int, messages: [[String: Any]]) {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return }

        sqlite3_exec(db, "BEGIN;", nil, nil, nil)
        defer { sqlite3_exec(db, "COMMIT;", nil, nil, nil) }

        let sql = """
            INSERT OR REPLACE INTO messages (
                id, conversation_id, sender_email, content, type,
                file_url, file_name, file_size, created_at,
                edited_at, deleted_at, reply_to_id, reactions_json, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }

        for message in messages {
            // Skip pending/temporary messages — they must NOT persist to SQLite
            if let idStr = message["id"] as? String, (idStr.hasPrefix("tmp_") || idStr.hasPrefix("tmp-")) { continue }
            if let pending = message["_pending"] as? Bool, pending { continue }
            if let failed = message["_failed"] as? Bool, failed { continue }

            // Robust id parsing — server may send Int, Double, NSNumber, or String
            let id: Int? = {
                if let i = message["id"] as? Int { return i }
                if let n = message["id"] as? NSNumber { return n.intValue }
                if let d = message["id"] as? Double { return Int(d) }
                if let s = message["id"] as? String, let i = Int(s) { return i }
                return nil
            }()
            guard let id = id, id > 0 else { continue }

            sqlite3_reset(stmt)
            sqlite3_bind_int64(stmt, 1, Int64(id))
            sqlite3_bind_int64(stmt, 2, Int64(conversationId))
            // ⭐ Robust string extraction — NSNull from JS JSON bridge must
            // be coerced to real String, never saved as SQL NULL.
            // This was the ROOT CAUSE of "empty bubbles" — content was saved
            // as NULL because NSNull as? String = nil.
            let safeStr: (Any?) -> String? = { val in
                if let s = val as? String { return s }
                if let n = val as? NSNumber { return n.stringValue }
                if val is NSNull { return nil }
                return nil
            }
            bindString(stmt, 3, safeStr(message["sender_email"]))
            bindString(stmt, 4, safeStr(message["content"]))
            bindString(stmt, 5, safeStr(message["type"]))
            bindString(stmt, 6, safeStr(message["file_url"]))
            bindString(stmt, 7, safeStr(message["file_name"]))
            if let size = (message["file_size"] as? Int) ?? (message["file_size"] as? Double).map({ Int($0) }) {
                sqlite3_bind_int64(stmt, 8, Int64(size))
            } else {
                sqlite3_bind_null(stmt, 8)
            }
            bindString(stmt, 9, message["created_at"] as? String)
            bindString(stmt, 10, message["edited_at"] as? String)
            bindString(stmt, 11, message["deleted_at"] as? String)
            if let rid = (message["reply_to_id"] as? Int) ?? (message["reply_to_id"] as? Double).map({ Int($0) }) {
                sqlite3_bind_int64(stmt, 12, Int64(rid))
            } else {
                sqlite3_bind_null(stmt, 12)
            }
            if let reactions = message["reactions"],
               let data = try? JSONSerialization.data(withJSONObject: reactions),
               let json = String(data: data, encoding: .utf8) {
                bindString(stmt, 13, json)
            } else {
                sqlite3_bind_null(stmt, 13)
            }
            // Store the entire message as JSON in payload_json so we can return it
            // verbatim on read — preserves any custom fields the JS layer added.
            // Sanitize: strip values that JSONSerialization can't encode (UIColor,
            // closures, functions). NSNull is fine — it round-trips.
            let sanitized = sanitizeForJSON(message)
            if JSONSerialization.isValidJSONObject(sanitized),
               let data = try? JSONSerialization.data(withJSONObject: sanitized, options: []),
               let json = String(data: data, encoding: .utf8) {
                bindString(stmt, 14, json)
            } else {
                // Fallback: at minimum store id+type+content so the row isn't lost
                let fallback: [String: Any] = [
                    "id": id,
                    "type": (message["type"] as? String) ?? "text",
                    "content": (message["content"] as? String) ?? "",
                    "sender_email": (message["sender_email"] as? String) ?? "",
                    "created_at": (message["created_at"] as? String) ?? "",
                ]
                if let data = try? JSONSerialization.data(withJSONObject: fallback),
                   let json = String(data: data, encoding: .utf8) {
                    bindString(stmt, 14, json)
                } else {
                    sqlite3_bind_null(stmt, 14)
                }
            }
            sqlite3_step(stmt)
        }
    }

    /// Recursively strip values JSONSerialization can't encode.
    private func sanitizeForJSON(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict {
                if v is NSNull { out[k] = NSNull(); continue }
                let sv = sanitizeForJSON(v)
                if JSONSerialization.isValidJSONObject([k: sv]) || sv is String || sv is NSNumber || sv is NSNull {
                    out[k] = sv
                }
            }
            return out
        }
        if let arr = value as? [Any] {
            return arr.map { sanitizeForJSON($0) }
        }
        if value is String || value is NSNumber || value is NSNull { return value }
        // Drop anything else
        return NSNull()
    }

    private func bindString(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String?) {
        if let v = value {
            // SQLITE_TRANSIENT — let SQLite copy the bytes
            sqlite3_bind_text(stmt, idx, (v as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        } else {
            sqlite3_bind_null(stmt, idx)
        }
    }

    // ─── Conversation list helpers ───────────────────────────────

    private func queryConversations() -> [[String: Any]] {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return [] }
        let sql = "SELECT id, payload_json FROM conversations ORDER BY last_timestamp DESC;"
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let cstr = sqlite3_column_text(stmt, 1) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                    }
                }
            }
        }
        sqlite3_finalize(stmt)
        return results
    }

    private func upsertConversations(conversations: [[String: Any]], replaceAll: Bool) {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return }

        sqlite3_exec(db, "BEGIN;", nil, nil, nil)
        defer { sqlite3_exec(db, "COMMIT;", nil, nil, nil) }

        if replaceAll {
            sqlite3_exec(db, "DELETE FROM conversations;", nil, nil, nil)
        }

        let sql = "INSERT OR REPLACE INTO conversations (id, last_timestamp, payload_json) VALUES (?, ?, ?);"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }

        for conv in conversations {
            guard let id = (conv["id"] as? Int) ?? (conv["id"] as? Double).map({ Int($0) }) else { continue }
            let ts = conv["last_timestamp"] as? String ?? conv["updated_at"] as? String ?? ""

            sqlite3_reset(stmt)
            sqlite3_bind_int64(stmt, 1, Int64(id))
            bindString(stmt, 2, ts)
            if let data = try? JSONSerialization.data(withJSONObject: conv, options: []),
               let json = String(data: data, encoding: .utf8) {
                bindString(stmt, 3, json)
            } else {
                sqlite3_bind_null(stmt, 3)
            }
            sqlite3_step(stmt)
        }
    }

    private func sortedConversations(_ list: [[String: Any]]) -> [[String: Any]] {
        return list.sorted { a, b in
            let at = (a["last_timestamp"] as? String) ?? (a["updated_at"] as? String) ?? ""
            let bt = (b["last_timestamp"] as? String) ?? (b["updated_at"] as? String) ?? ""
            return at > bt
        }
    }

    // ─── Media URI cache helpers ─────────────────────────────────

    private func queryMediaPath(remoteUrl: String) -> String? {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return nil }
        let sql = "SELECT local_path FROM media_uris WHERE remote_url = ?;"
        var stmt: OpaquePointer?
        var path: String?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (remoteUrl as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            if sqlite3_step(stmt) == SQLITE_ROW, let cstr = sqlite3_column_text(stmt, 0) {
                path = String(cString: cstr)
            }
        }
        sqlite3_finalize(stmt)
        return path
    }

    private func upsertMediaPath(remoteUrl: String, localPath: String, size: Int) {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return }
        let sql = "INSERT OR REPLACE INTO media_uris (remote_url, local_path, file_size, cached_at) VALUES (?, ?, ?, ?);"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (remoteUrl as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_text(stmt, 2, (localPath as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_int64(stmt, 3, Int64(size))
            sqlite3_bind_int64(stmt, 4, Int64(Date().timeIntervalSince1970))
            sqlite3_step(stmt)
        }
        sqlite3_finalize(stmt)
    }

    // ─── FTS5 search helpers ─────────────────────────────────────

    private func searchMessages(query: String, limit: Int) -> [[String: Any]] {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil, !query.isEmpty else { return [] }
        // FTS5 prefix matching: append * to last term so partial words match
        let tokens = query.split(separator: " ").map { String($0) + "*" }.joined(separator: " ")
        let sql = """
            SELECT m.payload_json
            FROM messages_fts f
            JOIN messages m ON m.id = f.rowid
            WHERE messages_fts MATCH ?
            ORDER BY rank
            LIMIT ?;
        """
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (tokens as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_int(stmt, 2, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let cstr = sqlite3_column_text(stmt, 0) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                    }
                }
            }
        }
        sqlite3_finalize(stmt)
        return results
    }

    private func searchEmails(query: String, folder: String?, limit: Int) -> [[String: Any]] {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil, !query.isEmpty else { return [] }
        let tokens = query.split(separator: " ").map { String($0) + "*" }.joined(separator: " ")
        // Join FTS rowid (= email uid) against the emails table to get the
        // full payload_json. Optionally filter by folder.
        let sql: String
        if folder != nil && folder != "" {
            sql = """
                SELECT e.payload_json
                FROM emails_fts f
                JOIN emails e ON e.uid = f.rowid AND e.folder = ?
                WHERE emails_fts MATCH ?
                ORDER BY rank
                LIMIT ?;
            """
        } else {
            // GROUP BY f.rowid: an FTS rowid is just the email uid, but the
            // emails table is keyed by (uid, folder). Without grouping, an
            // email present in two folders (e.g. INBOX + Archive) joins
            // twice and the search result list shows the same email twice.
            sql = """
                SELECT e.payload_json
                FROM emails_fts f
                JOIN emails e ON e.uid = f.rowid
                WHERE emails_fts MATCH ?
                GROUP BY f.rowid
                ORDER BY rank
                LIMIT ?;
            """
        }
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            var bindIdx: Int32 = 1
            if let f = folder, !f.isEmpty {
                sqlite3_bind_text(stmt, bindIdx, (f as NSString).utf8String, -1,
                                  unsafeBitCast(-1, to: sqlite3_destructor_type.self))
                bindIdx += 1
            }
            sqlite3_bind_text(stmt, bindIdx, (tokens as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            bindIdx += 1
            sqlite3_bind_int(stmt, bindIdx, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let cstr = sqlite3_column_text(stmt, 0) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                    }
                }
            }
        }
        sqlite3_finalize(stmt)
        return results
    }

    // ─── Email cache helpers ─────────────────────────────────────

    private func queryEmails(folder: String, limit: Int) -> [[String: Any]] {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return [] }
        let sql = "SELECT payload_json FROM emails WHERE folder = ? ORDER BY sort_date DESC LIMIT ?;"
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (folder as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_int(stmt, 2, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let cstr = sqlite3_column_text(stmt, 0) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                    }
                }
            }
        }
        sqlite3_finalize(stmt)
        return results
    }

    private func upsertEmails(folder: String, emails: [[String: Any]]) {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return }
        sqlite3_exec(db, "BEGIN;", nil, nil, nil)
        defer { sqlite3_exec(db, "COMMIT;", nil, nil, nil) }

        let sql = "INSERT OR REPLACE INTO emails (uid, folder, sort_date, payload_json) VALUES (?, ?, ?, ?);"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }

        for email in emails {
            let uid = (email["uid"] as? Int) ?? (email["uid"] as? Double).map({ Int($0) }) ?? 0
            if uid == 0 { continue }
            let dateStr = (email["date"] as? String) ?? (email["received_at"] as? String) ?? ""

            sqlite3_reset(stmt)
            sqlite3_bind_int64(stmt, 1, Int64(uid))
            sqlite3_bind_text(stmt, 2, (folder as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            bindString(stmt, 3, dateStr)
            if let data = try? JSONSerialization.data(withJSONObject: email, options: []),
               let json = String(data: data, encoding: .utf8) {
                bindString(stmt, 4, json)
            } else {
                sqlite3_bind_null(stmt, 4)
            }
            sqlite3_step(stmt)
        }
    }

    // ─── Drive cache helpers ─────────────────────────────────────

    private func queryDriveFiles(parentId: Int, limit: Int) -> [[String: Any]] {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return [] }
        let sql = "SELECT payload_json FROM drive_files WHERE parent_id = ? ORDER BY sort_name LIMIT ?;"
        var stmt: OpaquePointer?
        var results: [[String: Any]] = []
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_int64(stmt, 1, Int64(parentId))
            sqlite3_bind_int(stmt, 2, Int32(limit))
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let cstr = sqlite3_column_text(stmt, 0) {
                    let json = String(cString: cstr)
                    if let data = json.data(using: .utf8),
                       let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        results.append(parsed)
                    }
                }
            }
        }
        sqlite3_finalize(stmt)
        return results
    }

    private func upsertDriveFiles(parentId: Int, files: [[String: Any]]) {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return }
        sqlite3_exec(db, "BEGIN;", nil, nil, nil)
        defer { sqlite3_exec(db, "COMMIT;", nil, nil, nil) }

        // Replace contents of this folder atomically
        let del = "DELETE FROM drive_files WHERE parent_id = ?;"
        var dstmt: OpaquePointer?
        if sqlite3_prepare_v2(db, del, -1, &dstmt, nil) == SQLITE_OK {
            sqlite3_bind_int64(dstmt, 1, Int64(parentId))
            sqlite3_step(dstmt)
        }
        sqlite3_finalize(dstmt)

        let sql = "INSERT OR REPLACE INTO drive_files (id, parent_id, sort_name, payload_json) VALUES (?, ?, ?, ?);"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }

        for file in files {
            let id = (file["id"] as? Int) ?? (file["id"] as? Double).map({ Int($0) }) ?? 0
            if id == 0 { continue }
            let name = (file["name"] as? String) ?? ""

            sqlite3_reset(stmt)
            sqlite3_bind_int64(stmt, 1, Int64(id))
            sqlite3_bind_int64(stmt, 2, Int64(parentId))
            bindString(stmt, 3, name.lowercased())
            if let data = try? JSONSerialization.data(withJSONObject: file, options: []),
               let json = String(data: data, encoding: .utf8) {
                bindString(stmt, 4, json)
            } else {
                sqlite3_bind_null(stmt, 4)
            }
            sqlite3_step(stmt)
        }
    }

    // ─── Avatar cache helpers ────────────────────────────────────

    private func queryAvatarPath(email: String) -> String? {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return nil }
        let sql = "SELECT local_path FROM avatars WHERE email = ?;"
        var stmt: OpaquePointer?
        var path: String?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (email as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            if sqlite3_step(stmt) == SQLITE_ROW, let cstr = sqlite3_column_text(stmt, 0) {
                path = String(cString: cstr)
            }
        }
        sqlite3_finalize(stmt)
        return path
    }

    private func upsertAvatarPath(email: String, localPath: String) {
        dbLock.lock()
        defer { dbLock.unlock() }
        guard db != nil else { return }
        let sql = "INSERT OR REPLACE INTO avatars (email, local_path, cached_at) VALUES (?, ?, ?);"
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
            sqlite3_bind_text(stmt, 1, (email as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_text(stmt, 2, (localPath as NSString).utf8String, -1,
                              unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_int64(stmt, 3, Int64(Date().timeIntervalSince1970))
            sqlite3_step(stmt)
        }
        sqlite3_finalize(stmt)
    }

    private func downloadAvatar(email: String, remoteUrl: String) async {
        guard let url = URL(string: remoteUrl) else { return }
        // Stable filename: hash(email).jpg
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in email.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        let filename = String(format: "%016x.jpg", hash)
        let destPath = avatarCacheDir.appendingPathComponent(filename).path

        do {
            let (tmpUrl, _) = try await URLSession.shared.download(from: url)
            try? FileManager.default.removeItem(atPath: destPath)
            try FileManager.default.moveItem(atPath: tmpUrl.path, toPath: destPath)
            upsertAvatarPath(email: email, localPath: destPath)
            memLock.lock()
            avatarCache[email] = destPath
            memLock.unlock()
        } catch {
            // silent
        }
    }

    /// Compute a stable, full-strength SHA-256 hex string for a remote URL.
    /// Used as the cache filename so unrelated URLs cannot collide. The
    /// previous version stored only the first 8 bytes of an FNV-1a hash
    /// (which gave 64 bits of randomness compressed into a 16-char string)
    /// and a collision could overwrite an unrelated user's cached media.
    private func stableHash(_ s: String) -> String {
        let data = Data(s.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { buf in
            _ = CC_SHA256(buf.baseAddress, CC_LONG(data.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Get the file size at a path. Single correct extraction (the previous
    /// `(try? attrs[.size] as? Int) ?? 0 ?? 0` was nonsense and almost
    /// always returned 0, polluting the media cache size accounting).
    private func fileSize(at path: String) -> Int {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return 0 }
        if let n = attrs[.size] as? NSNumber { return n.intValue }
        if let i = attrs[.size] as? Int { return i }
        return 0
    }

    /// Download a remote URL to disk and register it. No-op on failure.
    private func downloadMedia(remoteUrl: String) async {
        guard let url = URL(string: remoteUrl) else { return }
        let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension
        let hash = stableHash(remoteUrl)
        let filename = "\(hash).\(ext)"
        let destPath = mediaCacheDir.appendingPathComponent(filename).path

        if FileManager.default.fileExists(atPath: destPath) {
            let size = fileSize(at: destPath)
            upsertMediaPath(remoteUrl: remoteUrl, localPath: destPath, size: size)
            memLock.lock()
            mediaCache[remoteUrl] = destPath
            memLock.unlock()
            return
        }

        do {
            let (tmpUrl, _) = try await URLSession.shared.download(from: url)
            try? FileManager.default.removeItem(atPath: destPath)
            try FileManager.default.moveItem(atPath: tmpUrl.path, toPath: destPath)
            let size = fileSize(at: destPath)
            upsertMediaPath(remoteUrl: remoteUrl, localPath: destPath, size: size)
            memLock.lock()
            mediaCache[remoteUrl] = destPath
            memLock.unlock()
        } catch {
            // Silent — JS will fall back to remote URL
        }
    }

    private func mergeIntoMemoryCache(conversationId: Int, messages: [[String: Any]]) {
        memLock.lock()
        defer { memLock.unlock() }
        var existing = memCache[conversationId] ?? []
        // Index by id for dedup
        var byId: [Int: [String: Any]] = [:]
        for m in existing {
            if let id = m["id"] as? Int { byId[id] = m }
        }
        for m in messages {
            // Skip pending messages from memory cache
            if let idStr = m["id"] as? String, (idStr.hasPrefix("tmp_") || idStr.hasPrefix("tmp-")) { continue }
            if let pending = m["_pending"] as? Bool, pending { continue }
            let id = (m["id"] as? Int) ?? (m["id"] as? Double).map({ Int($0) }) ?? 0
            if id > 0 { byId[id] = m }
        }
        // Re-build sorted ascending, cap at MEMORY_CACHE_SIZE most-recent
        let merged = byId.values.sorted { (a, b) -> Bool in
            let ai = (a["id"] as? Int) ?? 0
            let bi = (b["id"] as? Int) ?? 0
            return ai < bi
        }
        let capped = Array(merged.suffix(MEMORY_CACHE_SIZE))
        memCache[conversationId] = capped
    }
}
