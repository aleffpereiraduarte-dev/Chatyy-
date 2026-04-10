import ExpoModulesCore
import Photos
import UIKit
import CryptoKit
import AVFoundation
import ImageIO

struct UploadRequest: Record {
    @Field var assetId: String = ""
    @Field var presignedUrl: String = ""
    @Field var mimeType: String = "image/jpeg"
    @Field var maxWidth: Int = 0
    @Field var maxHeight: Int = 0
}

public class ExpoBackgroundUploadModule: Module {

    private let phManager = PHCachingImageManager()
    private var isRunning = false
    private var shouldStop = false
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    private let stateLock = NSLock()

    // ─── ETA / progress tracking ─────────────────────────────────
    // Rolling-window byte counter so the JS UI can show "X MB/s" and "X min remaining".
    // We sample bytes uploaded over the last ~10 seconds and divide.
    private struct ProgressSample { let timestamp: TimeInterval; let bytes: Int }
    private var progressSamples: [ProgressSample] = []
    private var totalBytesEstimated: Int = 0
    private var totalBytesUploaded: Int = 0
    private var totalAssets: Int = 0
    private var assetsUploaded: Int = 0
    private let progressLock = NSLock()

    // Single background session for uploads
    private var bgSession: URLSession!
    private var delegate: BGUploadDelegate!
    private var taskMap: [Int: String] = [:]
    private let lock = NSLock()
    private let taskMapKey = "com.onemundo.bgUpload.taskMap"

    private lazy var uploadDir: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent("bgUploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private func saveTaskMap() {
        let map = taskMap.reduce(into: [String: String]()) { $0[String($1.key)] = $1.value }
        UserDefaults.standard.set(map, forKey: taskMapKey)
    }

    private func loadTaskMap() {
        if let saved = UserDefaults.standard.dictionary(forKey: taskMapKey) as? [String: String] {
            taskMap = saved.reduce(into: [Int: String]()) { r, p in if let k = Int(p.key) { r[k] = p.value } }
        }
    }

    public func definition() -> ModuleDefinition {
        Name("ExpoBackgroundUpload")
        Events(
            "onProgress",       // legacy: { uploaded, total, assetId }
            "onComplete",       // per-photo: { assetId, success, httpStatus, deduped }
            "onBatchComplete",  // { remaining }
            "onScanProgress",   // { scanned, total, isComplete }
            "onUploadProgress"  // { uploaded, total, bytesUploaded, totalBytes, bytesPerSec, etaSec, currentFile }
        )

        OnCreate {
            self.delegate = BGUploadDelegate(module: self)
            let config = URLSessionConfiguration.background(
                withIdentifier: "com.onemundo.mail.bgUpload"
            )
            config.isDiscretionary = false
            config.sessionSendsLaunchEvents = true
            config.allowsCellularAccess = true
            config.timeoutIntervalForResource = 60 * 60 * 24
            self.bgSession = URLSession(configuration: config, delegate: self.delegate, delegateQueue: nil)
            self.loadTaskMap()
        }

        // Upload a batch of assets - copies to file:// and creates background upload tasks
        AsyncFunction("uploadBatch") { (requests: [UploadRequest]) -> [String: Any] in
            var queued = 0
            var failed = 0

            for request in requests {
                do {
                    try await self.copyAndUpload(request: request)
                    queued += 1
                } catch {
                    failed += 1
                }
            }

            return ["queued": queued, "failed": failed]
        }

        // SCAN PHASE — walk the entire photo library, count + size everything,
        // emit onScanProgress events as we go. JS shows a "Escaneando biblioteca..."
        // animation with the running count, exactly like Google Photos does
        // before the actual upload starts.
        AsyncFunction("scanLibrary") { () -> [String: Any] in
            let backedUpKey = "com.onemundo.backedUpAssets"
            let backedUpSet = Set(UserDefaults.standard.stringArray(forKey: backedUpKey) ?? [])

            let fetchOptions = PHFetchOptions()
            fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let allAssets = PHAsset.fetchAssets(with: fetchOptions)
            let total = allAssets.count

            self.sendEvent("onScanProgress", [
                "scanned": 0, "total": total, "isComplete": false,
            ])

            var pendingCount = 0
            var pendingBytes = 0
            var scanned = 0
            let lastEmit: NSLock = NSLock()
            var lastEmitTime: TimeInterval = 0

            allAssets.enumerateObjects { asset, _, _ in
                scanned += 1
                let assetId = asset.localIdentifier
                if !backedUpSet.contains(assetId) {
                    pendingCount += 1
                    // Estimate file size from PHAssetResource (no actual download)
                    if let resource = PHAssetResource.assetResources(for: asset).first,
                       let size = resource.value(forKey: "fileSize") as? Int {
                        pendingBytes += size
                    } else {
                        // Fallback: pixelWidth * pixelHeight * 0.5 bytes ~= jpeg estimate
                        pendingBytes += Int(Double(asset.pixelWidth * asset.pixelHeight) * 0.5)
                    }
                }
                // Throttle scan progress emissions to ~10/sec
                lastEmit.lock()
                let now = Date().timeIntervalSince1970
                if now - lastEmitTime > 0.1 || scanned == total {
                    lastEmitTime = now
                    lastEmit.unlock()
                    self.sendEvent("onScanProgress", [
                        "scanned": scanned,
                        "total": total,
                        "pending": pendingCount,
                        "pendingBytes": pendingBytes,
                        "isComplete": scanned == total,
                    ])
                } else {
                    lastEmit.unlock()
                }
            }

            self.progressLock.lock()
            self.totalAssets = pendingCount
            self.totalBytesEstimated = pendingBytes
            self.assetsUploaded = 0
            self.totalBytesUploaded = 0
            self.progressSamples.removeAll()
            self.progressLock.unlock()

            return [
                "totalScanned": total,
                "totalPending": pendingCount,
                "pendingBytes": pendingBytes,
            ]
        }

        // Start full backup using the Google-Photos-style CHUNKED upload protocol.
        //
        // Per-photo flow (sequential, 2 photos in parallel max):
        //   1. POST /api/rust/upload/init   → returns upload_id
        //   2. POST /api/rust/upload/chunk  (multipart, repeat for each ~4MB chunk)
        //   3. POST /api/rust/upload/complete → returns cdn_url + content_hash
        //   4. POST /api/email.php?action=drive_register_uploaded → creates DB row
        //   5. mark assetId as backed up in UserDefaults + emit onComplete
        //
        // Why chunked: nginx/Cloudflare have a 60s body timeout. Single-shot multipart
        // uploads of 5-15MB photos consistently hit HTTP 408 because HTTP/2 streams
        // share bandwidth and the 6th queued upload couldn't finish within 60s.
        // Chunked = each request is 1-3s = nginx never times out, retry is granular.
        AsyncFunction("startNativeBackup") { (serverUrl: String, authToken: String, userEmail: String) -> [String: Any] in
            self.stateLock.lock()
            if self.isRunning { self.stateLock.unlock(); return ["error": "already_running"] }
            self.isRunning = true
            self.shouldStop = false
            self.stateLock.unlock()

            // Request background time from iOS (30s - 4 minutes).
            // When expiry fires, gracefully stop uploading and notify JS
            // so the UI can show "Backup paused — open the app to continue".
            self.bgTaskId = await UIApplication.shared.beginBackgroundTask { [weak self] in
                guard let self = self else { return }
                self.stateLock.lock()
                self.shouldStop = true
                self.stateLock.unlock()
                // Notify JS that background time expired
                self.sendEvent("onBatchComplete", [
                    "remaining": -1,
                    "reason": "background_expired",
                ])
                if self.bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(self.bgTaskId)
                    self.bgTaskId = .invalid
                }
            }

            var uploaded = 0
            var total = 0

            defer {
                self.stateLock.lock()
                self.isRunning = false
                self.stateLock.unlock()
                if self.bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(self.bgTaskId)
                    self.bgTaskId = .invalid
                }
            }

            let backedUpKey = "com.onemundo.backedUpAssets"
            let backedUpSet = Set(UserDefaults.standard.stringArray(forKey: backedUpKey) ?? [])

            // ⭐ PRE-WARM HTTP/2 connection pool (Google Photos trick).
            // Sends a tiny HEAD request before the real uploads so by the time
            // we start the first real chunk, the TLS handshake + HTTP/2 connection
            // setup is already done. Saves ~300ms on the first photo and lets
            // subsequent uploads reuse the warm sockets.
            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<2 { // open 2 warm sockets to api-br
                    group.addTask {
                        guard let url = URL(string: serverUrl.replacingOccurrences(of: "/api/email.php", with: "") + "/api/rust/upload/init") else { return }
                        var req = URLRequest(url: url)
                        req.httpMethod = "OPTIONS"
                        req.timeoutInterval = 5
                        _ = try? await URLSession.shared.data(for: req)
                    }
                }
            }

            let fetchOptions = PHFetchOptions()
            fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let allAssets = PHAsset.fetchAssets(with: fetchOptions)
            total = allAssets.count

            // Origin host for the rust + php endpoints. Strip any query string.
            let origin: String = {
                if let q = serverUrl.firstIndex(of: "?") { return String(serverUrl[..<q]) }
                if serverUrl.hasSuffix("/api/email.php") {
                    return String(serverUrl.dropLast("/api/email.php".count))
                }
                return serverUrl
            }()

            // EIGHT parallel uploaders for Google Photos parity. Each runs the
            // full chunked flow for one asset, with chunks themselves uploaded
            // in parallel inside chunkedUploadAsset (CHUNK_PARALLELISM = 6).
            // Max in flight: 8 × 6 = 48 HTTP requests. NSURLSession multiplexes
            // them onto ~4-6 HTTP/2 sockets so this is safe.
            let concurrency = 8
            var enqueued = Set<String>()

            await withTaskGroup(of: Bool.self) { group in
                var running = 0
                var cursor = 0

                while cursor < allAssets.count && !self.shouldStop {
                    let asset = allAssets.object(at: cursor)
                    cursor += 1
                    let assetId = asset.localIdentifier
                    if backedUpSet.contains(assetId) || enqueued.contains(assetId) { continue }
                    enqueued.insert(assetId)

                    group.addTask {
                        return await self.chunkedUploadAsset(
                            asset: asset,
                            origin: origin,
                            authToken: authToken,
                            userEmail: userEmail
                        )
                    }
                    running += 1

                    if running >= concurrency {
                        if let success = await group.next() {
                            running -= 1
                            if success { uploaded += 1 }
                            if uploaded % 5 == 0 && uploaded > 0 {
                                self.sendEvent("onProgress", [
                                    "uploaded": uploaded, "total": total, "assetId": ""
                                ])
                            }
                        }
                    }
                }

                for await success in group {
                    if success { uploaded += 1 }
                }
            }

            return ["uploaded": uploaded, "total": total, "stopped": shouldStop]
        }

        Function("stopBackup") {
            self.stateLock.lock()
            self.shouldStop = true
            self.stateLock.unlock()
        }

        AsyncFunction("getActiveCount") { () -> Int in
            return await withCheckedContinuation { cont in
                self.bgSession.getAllTasks { tasks in
                    cont.resume(returning: tasks.filter { $0.state == .running || $0.state == .suspended }.count)
                }
            }
        }

        Function("cancelAll") {
            self.shouldStop = true
            self.bgSession.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
        }

        // Reset backed up IDs (for testing or to fix stale data)
        Function("resetBackedUpIds") {
            UserDefaults.standard.removeObject(forKey: "com.onemundo.backedUpAssets")
        }

        // Set backed up IDs from server (sync truth from DB)
        Function("setBackedUpIds") { (ids: [String]) in
            UserDefaults.standard.set(ids, forKey: "com.onemundo.backedUpAssets")
        }

        // Get backed up count
        Function("getBackedUpCount") { () -> Int in
            return UserDefaults.standard.stringArray(forKey: "com.onemundo.backedUpAssets")?.count ?? 0
        }
    }

    // ─── CHUNKED UPLOAD (Google Photos resumable-style) ──────────────────
    //
    // Per-photo flow against the Rust 9103 service + PHP register endpoint.
    // Returns true on full success (chunks + register), false on any failure.
    // Failures are silent here (the asset just won't be marked backed-up and
    // will be retried on the next backup pass).
    // Google Photos-grade tuning. They run ~8 files in parallel on WiFi with
    // 256KB-8MB chunks and reuse keep-alive connections via NSURLSession's
    // built-in connection pool. We mirror that:
    //   • 4MB chunks (balance: fewer requests, still small enough to retry cheap)
    //   • 6 chunks in flight per file
    //   • 8 files in flight in the outer task group (set in startNativeBackup)
    // → 48 simultaneous HTTP requests max. NSURLSession multiplexes them
    // over a small number of HTTP/2 connections so we don't actually open 48
    // sockets — typically 4-6 sockets total to api-br.chatyy.com.br.
    private static let CHUNK_SIZE: Int = 4 * 1024 * 1024
    private static let CHUNK_PARALLELISM: Int = 6

    private func chunkedUploadAsset(
        asset: PHAsset, origin: String, authToken: String, userEmail: String
    ) async -> Bool {
        let assetId = asset.localIdentifier
        var tempFile: URL?

        defer {
            if let t = tempFile { try? FileManager.default.removeItem(at: t) }
        }

        do {
            // 1. Copy PHAsset → real file
            let isVideo = asset.mediaType == .video
            tempFile = isVideo
                ? try await copyVideoToFile(asset: asset)
                : try await copyAssetToFile(asset: asset)
            guard let fileUrl = tempFile else { return false }

            let attrs = try FileManager.default.attributesOfItem(atPath: fileUrl.path)
            let fileSize = (attrs[.size] as? Int) ?? 0
            if fileSize <= 0 { return false }

            let filename = asset.originalFilename
                ?? (isVideo ? "video.mp4" : "photo.jpg")
            let mimeType = isVideo ? "video/mp4" : (
                filename.lowercased().hasSuffix("png") ? "image/png" :
                filename.lowercased().hasSuffix("heic") ? "image/heic" : "image/jpeg"
            )
            let totalChunks = max(1, (fileSize + Self.CHUNK_SIZE - 1) / Self.CHUNK_SIZE)

            // ⭐ HASH PRECHECK (Google Photos trick).
            // Before uploading 5MB of bytes, ask the server "do you already
            // have a file with this content_hash?". If yes, the server
            // re-links the existing R2 object under our drive_files table
            // and we skip the entire upload. Saves bandwidth + time on
            // duplicate photos (very common for re-installs / multi-device).
            let contentHash = sha256OfFile(url: fileUrl)
            if !contentHash.isEmpty {
                let precheckBody: [String: Any] = [
                    "content_hash": contentHash,
                    "filename": filename,
                    "asset_id": assetId,
                    "size": fileSize,
                    "mime_type": mimeType,
                ]
                if let resp = try? await postJSON(
                    url: origin + "/api/email.php?action=drive_register_uploaded",
                    authToken: authToken,
                    body: precheckBody
                ),
                   (resp["success"] as? Bool) == true,
                   let _ = resp["data"] as? [String: Any] {
                    // Server already had it — mark backed up, skip upload entirely
                    let key = "com.onemundo.backedUpAssets"
                    var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
                    if !ids.contains(assetId) {
                        ids.append(assetId)
                        UserDefaults.standard.set(ids, forKey: key)
                    }
                    sendEvent("onComplete", [
                        "assetId": assetId, "success": true, "httpStatus": 200, "deduped": true
                    ])
                    return true
                }
            }

            // 2. INIT — POST /api/rust/upload/init
            let initBody: [String: Any] = [
                "filename": filename,
                "total_size": fileSize,
                "total_chunks": totalChunks,
                "content_type": mimeType,
                "user_email": userEmail,
                "context": "photo-backup"
            ]
            guard let initResp = try await postJSON(
                url: origin + "/api/rust/upload/init",
                authToken: authToken,
                body: initBody
            ), let uploadId = initResp["upload_id"] as? String, !uploadId.isEmpty else {
                return false
            }

            // 3. CHUNKS — POST /api/rust/upload/chunk (multipart) in PARALLEL
            //
            // We pre-slice the file into chunks and send up to CHUNK_PARALLELISM
            // requests simultaneously. The Rust service handles chunks out-of-
            // order via their explicit chunk_index field, so this is safe.
            //
            // Why parallel chunks: a 12MB photo = 3 chunks. Sequential takes
            // ~3×1.5s = 4.5s per photo. Parallel = 1.5s. With 4 files in flight,
            // total throughput goes from ~1 photo/sec to ~3 photos/sec.
            let handle = try FileHandle(forReadingFrom: fileUrl)
            defer { try? handle.close() }

            // Pre-slice: read all chunks into memory upfront. For typical
            // 5-15 MB photos this is fine. Bigger files would need streaming.
            var chunks: [(index: Int, data: Data)] = []
            var offset = 0
            var idx = 0
            while offset < fileSize {
                let take = min(Self.CHUNK_SIZE, fileSize - offset)
                handle.seek(toFileOffset: UInt64(offset))
                let chunkData = handle.readData(ofLength: take)
                if chunkData.count != take { return false }
                chunks.append((idx, chunkData))
                offset += take
                idx += 1
            }
            try? handle.close()

            // Upload chunks in parallel batches of CHUNK_PARALLELISM
            var allOk = true
            await withTaskGroup(of: Bool.self) { group in
                var inFlight = 0
                var cursor = 0
                while cursor < chunks.count && allOk && !shouldStop {
                    let chunk = chunks[cursor]
                    cursor += 1
                    group.addTask { [weak self] in
                        do {
                            let ok = try await self?.postChunk(
                                url: origin + "/api/rust/upload/chunk",
                                authToken: authToken,
                                uploadId: uploadId,
                                chunkIndex: chunk.index,
                                chunkData: chunk.data
                            ) ?? false
                            if ok {
                                self?.recordProgress(bytes: chunk.data.count, currentFile: filename)
                            }
                            return ok
                        } catch {
                            return false
                        }
                    }
                    inFlight += 1
                    if inFlight >= Self.CHUNK_PARALLELISM {
                        if let ok = await group.next() {
                            inFlight -= 1
                            if !ok { allOk = false }
                        }
                    }
                }
                for await ok in group {
                    if !ok { allOk = false }
                }
            }
            if !allOk { return false }

            // 4. COMPLETE — POST /api/rust/upload/complete
            let completeBody: [String: Any] = [
                "upload_id": uploadId,
                "filename": filename,
                "content_type": mimeType,
                "user_email": userEmail,
                "context": "photo-backup"
            ]
            guard let completeResp = try await postJSON(
                url: origin + "/api/rust/upload/complete",
                authToken: authToken,
                body: completeBody
            ),
            let cdnUrl = completeResp["cdn_url"] as? String,
            !cdnUrl.isEmpty else {
                return false
            }
            // We already computed `contentHash` at the top of this function for
            // the precheck — reuse it (line above is intentionally NOT
            // re-declared to avoid shadowing).
            let serverSize = (completeResp["size"] as? Int) ?? fileSize

            // 5. REGISTER — POST /api/email.php?action=drive_register_uploaded
            let registerBody: [String: Any] = [
                "filename": filename,
                "cdn_url": cdnUrl,
                "size": serverSize,
                "mime_type": mimeType,
                "content_hash": contentHash,
                "asset_id": assetId
            ]
            let registerResp = try await postJSON(
                url: origin + "/api/email.php?action=drive_register_uploaded",
                authToken: authToken,
                body: registerBody
            )
            // PHP returns { success: true, data: { file_id: ... } }
            let registerOk = (registerResp?["success"] as? Bool) ?? false
            if !registerOk { return false }

            // 6. Mark backed up + emit onComplete + tick asset counter for ETA
            let key = "com.onemundo.backedUpAssets"
            var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
            if !ids.contains(assetId) {
                ids.append(assetId)
                UserDefaults.standard.set(ids, forKey: key)
            }
            recordAssetCompleted()
            sendEvent("onComplete", [
                "assetId": assetId, "success": true, "httpStatus": 200
            ])
            return true
        } catch {
            return false
        }
    }

    // ─── Progress / ETA helper ───────────────────────────────────
    /// Records that `bytes` were just uploaded and emits an onUploadProgress
    /// event with the rolling-window throughput + ETA.
    private func recordProgress(bytes: Int, currentFile: String?) {
        progressLock.lock()
        let now = Date().timeIntervalSince1970
        totalBytesUploaded += bytes
        progressSamples.append(ProgressSample(timestamp: now, bytes: bytes))
        // Drop samples older than 10 seconds
        let cutoff = now - 10.0
        while let first = progressSamples.first, first.timestamp < cutoff {
            progressSamples.removeFirst()
        }
        let windowBytes = progressSamples.reduce(0) { $0 + $1.bytes }
        let windowSpan = max(1.0, (progressSamples.last?.timestamp ?? now) - (progressSamples.first?.timestamp ?? now))
        let bytesPerSec = Double(windowBytes) / windowSpan
        let remaining = max(0, totalBytesEstimated - totalBytesUploaded)
        let etaSec = bytesPerSec > 0 ? Int(Double(remaining) / bytesPerSec) : 0
        let totalAssetsLocal = totalAssets
        let assetsUploadedLocal = assetsUploaded
        let totalBytesUploadedLocal = totalBytesUploaded
        let totalBytesEstimatedLocal = totalBytesEstimated
        progressLock.unlock()

        sendEvent("onUploadProgress", [
            "uploaded": assetsUploadedLocal,
            "total": totalAssetsLocal,
            "bytesUploaded": totalBytesUploadedLocal,
            "totalBytes": totalBytesEstimatedLocal,
            "bytesPerSec": Int(bytesPerSec),
            "etaSec": etaSec,
            "currentFile": currentFile ?? "",
        ])
    }

    private func recordAssetCompleted() {
        progressLock.lock()
        assetsUploaded += 1
        progressLock.unlock()
    }

    // SHA-256 of a file's contents (streaming, low memory)
    private func sha256OfFile(url: URL) -> String {
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hasher = SHA256()
            while autoreleasepool(invoking: { () -> Bool in
                let chunk = handle.readData(ofLength: 1 * 1024 * 1024)
                if chunk.isEmpty { return false }
                hasher.update(data: chunk)
                return true
            }) {}
            let digest = hasher.finalize()
            return digest.map { String(format: "%02x", $0) }.joined()
        } catch {
            return ""
        }
    }

    // POST a JSON body, return parsed JSON dict on 2xx success.
    private func postJSON(
        url: String, authToken: String, body: [String: Any]
    ) async throws -> [String: Any]? {
        guard let u = URL(string: url) else { return nil }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode) else {
            return nil
        }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    // POST a single chunk as multipart/form-data. Returns true on 2xx.
    private func postChunk(
        url: String, authToken: String,
        uploadId: String, chunkIndex: Int, chunkData: Data
    ) async throws -> Bool {
        guard let u = URL(string: url) else { return false }
        let boundary = "Boundary-\(UUID().uuidString)"

        var body = Data()
        // upload_id field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"upload_id\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(uploadId)\r\n".data(using: .utf8)!)
        // chunk_index field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"chunk_index\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(chunkIndex)\r\n".data(using: .utf8)!)
        // chunk binary
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"chunk\"; filename=\"c\(chunkIndex).bin\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: application/octet-stream\r\n\r\n".data(using: .utf8)!)
        body.append(chunkData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        req.httpBody = body

        // Retry transient failures up to 3 times with backoff
        for attempt in 0..<3 {
            do {
                let (_, response) = try await URLSession.shared.data(for: req)
                if let http = response as? HTTPURLResponse,
                   (200...299).contains(http.statusCode) {
                    return true
                }
            } catch {
                // network error — fall through to retry
            }
            try? await Task.sleep(nanoseconds: UInt64((attempt + 1) * 500_000_000))
        }
        return false
    }

    /// Strip EXIF metadata (GPS, camera info, etc.) from image data before upload.
    /// Preserves image quality — only removes metadata properties.
    private func stripExifMetadata(from imageData: Data) -> Data {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let uti = CGImageSourceGetType(source) else { return imageData }
        let mutableData = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(mutableData, uti, 1, nil) else { return imageData }
        // Copy the image but strip metadata properties that leak private info
        let removeKeys: [CFString] = [kCGImagePropertyGPSDictionary,
                                       kCGImagePropertyExifDictionary,
                                       kCGImagePropertyExifAuxDictionary,
                                       kCGImagePropertyMakerAppleDictionary]
        var options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 1.0]
        for key in removeKeys { options[key] = kCFNull }
        CGImageDestinationAddImageFromSource(dest, source, 0, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return imageData }
        return mutableData as Data
    }

    // Copy PHAsset to a real file in Caches
    private func copyAssetToFile(asset: PHAsset) async throws -> URL {
        return try await withCheckedThrowingContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            options.isSynchronous = false

            self.phManager.requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, info in
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.resume(throwing: error); return
                }
                guard let data = data else {
                    continuation.resume(throwing: NSError(domain: "BGUpload", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "No image data"])); return
                }

                // Strip EXIF metadata (GPS location, camera info) before upload
                let cleanData = self.stripExifMetadata(from: data)

                let ext = (uti ?? "").contains("heic") ? "heic" : ((uti ?? "").contains("png") ? "png" : "jpg")
                let fileName = UUID().uuidString + "." + ext
                let fileUrl = self.uploadDir.appendingPathComponent(fileName)

                do {
                    try cleanData.write(to: fileUrl, options: [.atomic])
                    // No data protection so nsurlsessiond can read it
                    try (fileUrl as NSURL).setResourceValue(URLFileProtection.none, forKey: .fileProtectionKey)
                    continuation.resume(returning: fileUrl)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    // Also handle video assets
    private func copyVideoToFile(asset: PHAsset) async throws -> URL {
        return try await withCheckedThrowingContinuation { continuation in
            let options = PHVideoRequestOptions()
            options.isNetworkAccessAllowed = true

            self.phManager.requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                guard let urlAsset = avAsset as? AVURLAsset else {
                    continuation.resume(throwing: NSError(domain: "BGUpload", code: 4,
                        userInfo: [NSLocalizedDescriptionKey: "No video"])); return
                }
                let fileName = UUID().uuidString + "." + urlAsset.url.pathExtension
                let destUrl = self.uploadDir.appendingPathComponent(fileName)
                do {
                    try FileManager.default.copyItem(at: urlAsset.url, to: destUrl)
                    try (destUrl as NSURL).setResourceValue(URLFileProtection.none, forKey: .fileProtectionKey)
                    continuation.resume(returning: destUrl)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    // Copy + upload in one step (for uploadBatch)
    private func copyAndUpload(request: UploadRequest) async throws {
        let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [request.assetId], options: nil)
        guard let asset = fetchResult.firstObject else { throw NSError(domain: "BGUpload", code: 1, userInfo: nil) }

        let tempFile: URL
        if asset.mediaType == .video {
            tempFile = try await copyVideoToFile(asset: asset)
        } else {
            tempFile = try await copyAssetToFile(asset: asset)
        }

        // Verify size > 0
        let attrs = try FileManager.default.attributesOfItem(atPath: tempFile.path)
        guard (attrs[.size] as? UInt64 ?? 0) > 0 else {
            try? FileManager.default.removeItem(at: tempFile)
            throw NSError(domain: "BGUpload", code: 5, userInfo: nil)
        }

        // Create background upload task
        guard let url = URL(string: request.presignedUrl) else {
            try? FileManager.default.removeItem(at: tempFile)
            throw NSError(domain: "BGUpload", code: 3, userInfo: nil)
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "PUT"

        let task = bgSession.uploadTask(with: urlRequest, fromFile: tempFile)

        lock.lock()
        taskMap[task.taskIdentifier] = request.assetId
        tempFiles[task.taskIdentifier] = tempFile
        saveTaskMap()
        lock.unlock()

        task.resume()
    }

    private var tempFiles: [Int: URL] = [:]

    // Create a multipart upload task for PHP server
    private func createMultipartUploadTask(url: String, fileUrl: URL, authToken: String, filename: String, mimeType: String, assetId: String) throws {
        guard let uploadUrl = URL(string: url) else { throw NSError(domain: "BGUpload", code: 3, userInfo: nil) }

        let boundary = "Boundary-\(UUID().uuidString)"

        // Build multipart body and save to file (required for background upload)
        let bodyUrl = uploadDir.appendingPathComponent("body_\(UUID().uuidString).tmp")
        let fileData = try Data(contentsOf: fileUrl)

        var body = Data()
        let deviceName = UIDevice.current.name
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"device_name\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(deviceName)\r\n".data(using: .utf8)!)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        try body.write(to: bodyUrl, options: [.atomic])
        try (bodyUrl as NSURL).setResourceValue(URLFileProtection.none, forKey: .fileProtectionKey)

        // Delete the original temp file (data is now in body file)
        try? FileManager.default.removeItem(at: fileUrl)

        var request = URLRequest(url: uploadUrl)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

        let task = bgSession.uploadTask(with: request, fromFile: bodyUrl)

        lock.lock()
        taskMap[task.taskIdentifier] = assetId
        tempFiles[task.taskIdentifier] = bodyUrl
        saveTaskMap()
        lock.unlock()

        task.resume()
    }

    fileprivate func handleProgress(taskId: Int, sent: Int64, total: Int64) {
        lock.lock()
        let assetId = taskMap[taskId]
        lock.unlock()
        guard let assetId = assetId else { return }
        sendEvent("onProgress", ["assetId": assetId, "progress": total > 0 ? Double(sent)/Double(total) : 0])
    }

    fileprivate func handleComplete(taskId: Int, response: HTTPURLResponse?, error: Error?) {
        lock.lock()
        let assetId = taskMap.removeValue(forKey: taskId)
        let tempURL = tempFiles.removeValue(forKey: taskId)
        let remaining = taskMap.count
        saveTaskMap()
        lock.unlock()

        if let tempURL = tempURL { try? FileManager.default.removeItem(at: tempURL) }
        guard let assetId = assetId else { return }

        let status = response?.statusCode ?? 0
        let success = error == nil && (200...299).contains(status)

        // Mark as backed up if successful
        if success {
            let key = "com.onemundo.backedUpAssets"
            var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
            if !ids.contains(assetId) {
                ids.append(assetId)
                UserDefaults.standard.set(ids, forKey: key)
            }
        }

        sendEvent("onComplete", ["assetId": assetId, "success": success, "httpStatus": status])
        if remaining == 0 { sendEvent("onBatchComplete", ["remaining": 0]) }
    }
}

// Original filename extension for PHAsset
extension PHAsset {
    var originalFilename: String? {
        return PHAssetResource.assetResources(for: self).first?.originalFilename
    }
}

private class BGUploadDelegate: NSObject, URLSessionTaskDelegate, URLSessionDelegate {
    weak var module: ExpoBackgroundUploadModule?
    init(module: ExpoBackgroundUploadModule) { self.module = module }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        module?.handleProgress(taskId: task.taskIdentifier, sent: totalBytesSent, total: totalBytesExpectedToSend)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        module?.handleComplete(taskId: task.taskIdentifier, response: task.response as? HTTPURLResponse, error: error)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let identifier = session.configuration.identifier else { return }
        DispatchQueue.main.async {
            if let handler = BackgroundUploadAppDelegateSubscriber.completionHandlers.removeValue(forKey: identifier) {
                handler()
            }
        }
    }
}
