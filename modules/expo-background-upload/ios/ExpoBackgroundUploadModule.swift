import ExpoModulesCore
import Photos
import UIKit
import CryptoKit
import AVFoundation
import ImageIO
import BackgroundTasks
import UserNotifications

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
    // PHPhotoLibrary observer wrapper — Apple requires the conformer to be a
    // pure Objective-C subclass of NSObject, but ExpoModulesCore's Module
    // base class already inherits from NSObject so we attach via a tiny
    // private observer object instead of conforming directly (keeps the
    // ExpoModulesCore class hierarchy clean).
    private var libraryObserver: PhotoLibraryObserver?
    private var lastObserverFireAt: TimeInterval = 0

    /// Schedule a local "Backup completo!" notification. Called from the
    /// `defer` of startNativeBackup whenever uploads finished and the app
    /// is in the background (so the user knows even without opening the app).
    private func notifyBackupComplete(count: Int) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "Backup completo"
            content.body = "\(count) \(count == 1 ? "foto enviada" : "fotos enviadas") com sucesso."
            content.sound = .default
            let req = UNNotificationRequest(
                identifier: "chatyy.backup.complete",
                content: content,
                trigger: nil  // deliver immediately
            )
            center.add(req, withCompletionHandler: nil)
        }
    }

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
    // Guards UserDefaults read-modify-write on the backed-up asset list. Without
    // this, 8 parallel uploaders can each read the current array, append their
    // own id, and write back — the last writer wins and the others are lost,
    // which makes a subset of photos look "unbacked" on next start and get
    // re-uploaded. Every mutation goes through markAssetBackedUp().
    private let backedUpLock = NSLock()

    private func markAssetBackedUp(_ assetId: String) {
        let key = "com.onemundo.backedUpAssets"
        backedUpLock.lock()
        defer { backedUpLock.unlock() }
        var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
        if !ids.contains(assetId) {
            ids.append(assetId)
            UserDefaults.standard.set(ids, forKey: key)
        }
    }

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

            // ─── BGTaskScheduler: wake us up in background periodically ───
            // The actual `BGTaskScheduler.shared.register(...)` call lives in
            // BackgroundUploadAppDelegateSubscriber — Apple requires that
            // happen during didFinishLaunchingWithOptions, and iOS 18+ kills
            // the app on launch with NSInternalInconsistencyException if it
            // doesn't. We just install the handlers here and flush any tasks
            // that iOS may have woken us with before the JS bridge was ready.
            BackgroundUploadAppDelegateSubscriber.refreshHandler = { [weak self] task in
                self?.handleBackgroundBackup(task: task)
            }
            BackgroundUploadAppDelegateSubscriber.processingHandler = { [weak self] task in
                self?.handleBackgroundProcessing(task: task)
            }
            BackgroundUploadAppDelegateSubscriber.flushPendingTasks()
            // Belt-and-suspenders: if the AppDelegate hook didn't fire (e.g.
            // module loaded standalone in a unit test), still try to register.
            BackgroundUploadAppDelegateSubscriber.registerBGTasksOnce()
            // Schedule a first run so iOS starts learning when to wake us.
            self.scheduleBackgroundRefresh()
            self.scheduleBackgroundProcessing()

            // ─── Photo library observer (Phase 2 native) ─────────────────
            // PHPhotoLibraryChangeObserver fires the instant a new photo is
            // saved to the library — much faster than the JS-side
            // MediaLibrary.addListener (which polls). We use the fire as a
            // signal to schedule a BGProcessingTask early so the next iOS
            // wake-up window picks the new photo up.
            //
            // Throttled to fire at most once every 60s so a burst of camera
            // captures doesn't queue dozens of background-processing
            // schedule calls.
            if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized
                || PHPhotoLibrary.authorizationStatus(for: .readWrite) == .limited {
                self.libraryObserver = PhotoLibraryObserver { [weak self] in
                    guard let self = self else { return }
                    let now = Date().timeIntervalSince1970
                    if now - self.lastObserverFireAt < 60 { return }
                    self.lastObserverFireAt = now
                    NSLog("[BackgroundUpload] PHPhotoLibrary changed — scheduling early BG processing")
                    self.scheduleBackgroundProcessing()
                }
                PHPhotoLibrary.shared().register(self.libraryObserver!)
            }
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

            // Sweep orphaned temp files from previous crashed/interrupted
            // sessions. These accumulate when the app dies mid-upload (OOM,
            // app killed, etc.) and the deferred cleanup never runs. Without
            // this, a few crashes can fill /Caches with multi-GB videos.
            // We only delete files older than 10 minutes so we never race
            // against an active upload.
            do {
                let fm = FileManager.default
                if let files = try? fm.contentsOfDirectory(at: self.uploadDir, includingPropertiesForKeys: [.contentModificationDateKey]) {
                    let cutoff = Date().addingTimeInterval(-600)
                    for f in files {
                        if let mtime = try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                           mtime < cutoff {
                            try? fm.removeItem(at: f)
                        }
                    }
                }
            }

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
                // Phase 2 native: post a local notification on completion so
                // the user sees "Backup completo" without opening the app.
                // Only fires if we actually uploaded something AND the app
                // is running in background (UIApplication state != active).
                if uploaded > 0 && UIApplication.shared.applicationState != .active {
                    self.notifyBackupComplete(count: uploaded)
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

            // REDUCED from 24 → 4. User reported every chunk upload dying
            // with HTTP 499 (client abort after 37-40s) on mobile network.
            // Cause was 24 photos × 6 chunks = 144 parallel HTTP requests;
            // iPhone's mobile radio can push maybe 2-3 MB/s total, which
            // means each chunk sits queued and blows past the 30s URLSession
            // body-transmission deadline. 4 × 2 = 8 in-flight is a much
            // better fit for 3G/slow-WiFi while still saturating 5G. Users
            // on fast networks lose ~20% theoretical max throughput; users
            // on slow networks go from "0 uploaded ever" to "actually works".
            //
            // REDUCED 4 → 2 in build 433. With direct-to-R2 single-PUT
            // (build 431+), each task holds ~100MB peak memory:
            //   • copyAssetToFile loads full HEIC bytes into Data
            //   • stripExifMetadata re-encodes via CGImageSource (2nd copy)
            //   • write to disk
            // 4 concurrent × ~100MB = ~400MB peak which triggers iOS jetsam
            // and kills the app mid-backup. Build 432 was uploading then
            // crashing. 2 keeps peak ~200MB which is safely under the limit.
            let concurrency = 2

            // Pre-warm PhotoKit's image cache for the next batch so when a
            // worker finishes and moves to the next asset, the bytes are
            // already resident (PHCachingImageManager fetches from iCloud
            // Photo Library in the background if the original is cloud-only).
            // We cache a rolling window of 100 assets ahead of the upload
            // pointer. Without this, every worker paid the ~300-500ms iCloud
            // fetch cost serially before it could touch the bytes.
            // PHCachingImageManager prefetch removed in build 434.
            //
            // startCachingImages with PHImageManagerMaximumSize asks
            // PhotoKit to keep full-size raster data resident for 100
            // assets ahead of the cursor. For a 12MP photo that's ~50MB
            // of raster each → 5GB held in memory. Combined with 2
            // concurrent in-flight uploads this overflowed the iOS app
            // memory budget and triggered jetsam. The original
            // justification ("paid the ~300-500ms iCloud fetch cost
            // serially") only applies to assets stored as cloud-only;
            // for the typical user with most photos local, the cache
            // delivers no win and burns a multi-GB working set.
            //
            // Each per-asset requestImageDataAndOrientation now fetches
            // lazily. iCloud-only assets pay a one-time fetch cost.
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

                    // Rolling cache window removed in build 434 (see
                    // comment above). Fetches are lazy per-asset now.

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

        // JS calls this after login so that when iOS wakes us up in the
        // background to run scheduled backups, we have the credentials
        // cached (JS isn't running at BG-task time).
        Function("setBackupCreds") { (serverUrl: String, authToken: String, userEmail: String) in
            self.saveBackupCreds(serverUrl: serverUrl, authToken: authToken, userEmail: userEmail)
        }

        // Manually request the scheduler to run soon. Lets the UI offer a
        // "run backup now even if phone is locked" button that submits a
        // fresh BGAppRefresh task with earliestBeginDate=now.
        Function("requestBackgroundBackupNow") {
            self.scheduleBackgroundRefresh()
            self.scheduleBackgroundProcessing()
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
    // Chunk size bumped from 4→8 MB. Most photos (HEIC/JPEG) fit in one
    // chunk now, which eliminates the 2-chunk round-trip that dominated
    // per-photo time. Videos still split into multiple chunks but fewer
    // of them. 8 MB is well within the HTTP/2 idle-stream budget.
    private static let CHUNK_SIZE: Int = 8 * 1024 * 1024
    // REDUCED 6 → 2. See comment at concurrency=4 above. Mobile radio
    // can't push 6 chunks × 8 MB = 48 MB in parallel without each chunk
    // timing out. 2 is enough to overlap TLS handshake / HTTP/2 window
    // ramp-up without oversubscribing the upload pipe.
    private static let CHUNK_PARALLELISM: Int = 2

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

            // HASH PRECHECK — run for ALL files, not just >10 MB.
            //
            // Why: the precheck roundtrip (~100-200ms) is way cheaper than a
            // full upload (~2-5s for a typical photo). When the library has
            // drifted from the server (e.g. user reinstalled + local
            // backedUpSet shrank, or iCloud re-synced with fresh asset_ids),
            // we'd otherwise re-upload tens of thousands of photos that are
            // already on the server — each one consuming 2-5s of the upload
            // pipeline just to hit ON CONFLICT DO UPDATE on the server.
            // Precheck short-circuits that: SHA256 the file (streaming, fast
            // even for HEIC), POST content_hash, server returns "deduped:
            // true" instantly for already-uploaded content → we skip the
            // full upload and move on.
            let contentHash = sha256OfFile(url: fileUrl)
            if !contentHash.isEmpty {
                let precheckBody: [String: Any] = [
                    "content_hash": contentHash,
                    "filename": filename,
                    "asset_id": assetId,
                    "size": fileSize,
                    "mime_type": mimeType,
                ]
                // Precheck goes straight to Rust — bypasses PHP-FPM which
                // was saturating at 50 workers and returning 499 timeouts.
                // The new Rust endpoint queries drive_files on a dedicated
                // PG pool, typical response <20ms even under load.
                var precheckBodyAuth = precheckBody
                precheckBodyAuth["user_email"] = userEmail
                if let resp = try? await postJSON(
                    url: origin + "/api/rust/backup/precheck",
                    authToken: authToken,
                    body: precheckBodyAuth
                ),
                   (resp["success"] as? Bool) == true,
                   let _ = resp["data"] as? [String: Any] {
                    markAssetBackedUp(assetId)
                    sendEvent("onComplete", [
                        "assetId": assetId, "success": true, "httpStatus": 200, "deduped": true
                    ])
                    return true
                }
            }

            // ─── DIRECT-TO-R2 PATH (Google Photos style) ─────────────────
            // 2. SIGN — POST /api/email.php?action=drive_init_upload
            //    Server returns a presigned R2 PUT URL + creates the
            //    drive_files row (size=0, will be filled by step 4).
            //
            // 3. PUT — single PUT directly to R2 (chatyy-media bucket) with
            //    the file body. No proxy, no chunking, no PHP-FPM workers
            //    holding the bytes. R2 ingests at ~50–80 MB/s per stream.
            //
            // 4. CONFIRM — POST /api/email.php?action=drive_confirm_upload
            //    Server does a HEAD on R2 to verify the object landed and
            //    updates the row's size + content_hash.
            //
            // 5. Mark assetId as backed up locally (UserDefaults).
            //
            // Why this is faster than the old init/chunk/complete chain:
            //   • Old: bytes go App → nginx → Rust → R2 (2× bandwidth, every
            //     chunk hits a PHP/Rust worker, 4 RTTs to our server per file).
            //   • New: bytes go App → R2 directly (1× bandwidth, 2 thin
            //     PHP RTTs per file just to sign + confirm).

            // 2. SIGN — include asset_id + content_hash so server can:
            //   (a) suffix the DB filename with md5(asset_id)[:10] so two
            //       distinct photos that happen to share the same original
            //       filename ("IMG_1234.PNG") don't collide on the unique
            //       (user_email, name) index. Without this, ON CONFLICT
            //       UPDATE merges them onto a single row → server count
            //       gets stuck while the engine keeps firing PUTs that all
            //       point at the same row.
            //   (b) short-circuit the whole upload (skip the PUT) when the
            //       content_hash matches an existing row → instant dedup,
            //       no bandwidth wasted.
            let signBody: [String: Any] = [
                "filename": filename,
                "mime_type": mimeType,
                "asset_id": assetId,
                "content_hash": contentHash,
                "size": fileSize
            ]
            guard let signResp = try await postJSON(
                url: origin + "/api/email.php?action=drive_init_upload",
                authToken: authToken,
                body: signBody
            ),
            (signResp["success"] as? Bool) == true,
            let data = signResp["data"] as? [String: Any] else {
                return false
            }

            // Short-circuit: server told us this content_hash is already
            // backed up. Mark locally and move on without touching R2.
            if let deduped = data["deduped"] as? Bool, deduped {
                markAssetBackedUp(assetId)
                recordAssetCompleted()
                sendEvent("onComplete", [
                    "assetId": assetId, "success": true, "httpStatus": 200, "deduped": true
                ])
                return true
            }

            guard let uploadUrl = data["upload_url"] as? String,
                  let objectKey = data["object_key"] as? String,
                  let fileId = data["file_id"] as? Int else {
                return false
            }

            // 3. PUT direct to R2 — single shot, body from file (low memory)
            guard let r2Url = URL(string: uploadUrl) else { return false }
            var putReq = URLRequest(url: r2Url)
            putReq.httpMethod = "PUT"
            putReq.setValue(mimeType, forHTTPHeaderField: "Content-Type")
            putReq.setValue("\(fileSize)", forHTTPHeaderField: "Content-Length")
            // R2 SigV4 was signed with `host` only — no auth header.
            // 5 min timeout for the big upload phase.
            putReq.timeoutInterval = 300

            do {
                let (_, putResponse) = try await URLSession.shared.upload(for: putReq, fromFile: fileUrl)
                guard let http = putResponse as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    return false
                }
            } catch {
                return false
            }
            recordProgress(bytes: fileSize, currentFile: filename)

            // 4. CONFIRM — server HEADs R2 and updates the drive_files row.
            //    Pass content_hash so the row is searchable by hash for
            //    future dedup precheck.
            let confirmBody: [String: Any] = [
                "file_id": fileId,
                "s3_key": objectKey,
                "content_hash": contentHash,
                "asset_id": assetId
            ]
            guard let confirmResp = try await postJSON(
                url: origin + "/api/email.php?action=drive_confirm_upload",
                authToken: authToken,
                body: confirmBody
            ),
            (confirmResp["success"] as? Bool) == true else {
                return false
            }

            // 5. Mark backed up + emit onComplete + tick counter for ETA
            markAssetBackedUp(assetId)
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

    /// Strip EXIF metadata via CGImageDestination — REMOVED in build 434.
    ///
    /// CGImageDestinationAddImageFromSource decodes the source raster and
    /// re-encodes it through AppleJPEG/HEIC. For a 12MP iPhone photo that
    /// raster is ~50MB and the encode buffers reach ~100MB peak. Multiplied
    /// by 2 concurrent uploads this exceeds the iOS app jetsam limit and
    /// crashes with EXC_CRASH/SIGABRT inside __CFRaiseMemoryException.
    ///
    /// Trade-off: the upload now keeps the original asset's EXIF (GPS,
    /// camera info, etc.). That data is already on the user's device — the
    /// bucket is private to the user — and the server can strip on serve
    /// for any third-party sharing path. Stripping client-side is not
    /// worth crashing the backup loop for.
    private func stripExifMetadata(from imageData: Data) -> Data {
        return imageData
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
            markAssetBackedUp(assetId)
        }

        sendEvent("onComplete", ["assetId": assetId, "success": success, "httpStatus": status])
        if remaining == 0 { sendEvent("onBatchComplete", ["remaining": 0]) }
    }

    // ═══════════════════════════════════════════════════════════════════
    // BGTaskScheduler — Google Photos / Apple Photos-style background backup
    // ═══════════════════════════════════════════════════════════════════
    //
    // iOS lets us register identifiers that it wakes up in background:
    //   • BGAppRefreshTask — up to 30s, fires every few hours, best-effort
    //   • BGProcessingTask — minutes of runtime, fires when device idle + on
    //                        charger + on Wi-Fi (so heavy backups don't drain
    //                        battery or data). Google Photos uses both.
    //
    // Each handler must:
    //   1. Set an expirationHandler that cancels our work if iOS runs out of
    //      patience (don't overstay or iOS throttles us for future runs).
    //   2. Enqueue uploads into URLSession.background (which already survives
    //      after the task ends — iOS keeps those going up to 24h).
    //   3. Call setTaskCompleted(success:) when done.
    //   4. Reschedule so we get called again next cycle.

    // Read credentials saved from the last foreground run. Without these, the
    // BG task can't authenticate (JS isn't running to pass them in).
    private func savedBackupCreds() -> (serverUrl: String, authToken: String, userEmail: String)? {
        let d = UserDefaults.standard
        let s = d.string(forKey: "com.onemundo.backup.serverUrl") ?? ""
        let t = d.string(forKey: "com.onemundo.backup.authToken") ?? ""
        let e = d.string(forKey: "com.onemundo.backup.userEmail") ?? ""
        guard !s.isEmpty, !t.isEmpty, !e.isEmpty else { return nil }
        return (s, t, e)
    }

    /// Schedule the next BGAppRefreshTask. Called both from OnCreate and at
    /// the end of each handler run.
    private func scheduleBackgroundRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: "com.onemundo.mail.backup.refresh")
        // ~15 minutes out — iOS may delay (typically 1-4h). Earliest is soft.
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do { try BGTaskScheduler.shared.submit(req) } catch {
            NSLog("[bgBackup] refresh submit failed: \(error)")
        }
    }

    /// Schedule a long-running processing task. iOS only runs these when the
    /// device is plugged in + Wi-Fi, so we ask for more work (larger batches).
    private func scheduleBackgroundProcessing() {
        let req = BGProcessingTaskRequest(identifier: "com.onemundo.mail.backup.processing")
        req.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60) // 1h
        req.requiresNetworkConnectivity = true
        req.requiresExternalPower = false // allow on battery — Google Photos does
        do { try BGTaskScheduler.shared.submit(req) } catch {
            NSLog("[bgBackup] processing submit failed: \(error)")
        }
    }

    /// Short-budget refresh task. Quick scan, enqueue ~50 photos via
    /// bgSession, return. bgSession continues uploading after we exit.
    private func handleBackgroundBackup(task: BGAppRefreshTask) {
        scheduleBackgroundRefresh() // chain the next run
        task.expirationHandler = { [weak self] in
            self?.shouldStop = true
        }
        guard let creds = savedBackupCreds() else { task.setTaskCompleted(success: false); return }
        Task {
            let completed = await self.runBackgroundBackupSlice(
                serverUrl: creds.serverUrl,
                authToken: creds.authToken,
                userEmail: creds.userEmail,
                maxAssets: 30,   // short budget
                timeoutSec: 25
            )
            task.setTaskCompleted(success: completed)
        }
    }

    /// Long-budget processing task. Same flow but bigger batch.
    private func handleBackgroundProcessing(task: BGProcessingTask) {
        scheduleBackgroundProcessing() // chain
        task.expirationHandler = { [weak self] in
            self?.shouldStop = true
        }
        guard let creds = savedBackupCreds() else { task.setTaskCompleted(success: false); return }
        Task {
            let completed = await self.runBackgroundBackupSlice(
                serverUrl: creds.serverUrl,
                authToken: creds.authToken,
                userEmail: creds.userEmail,
                maxAssets: 500,  // generous
                timeoutSec: 4 * 60
            )
            task.setTaskCompleted(success: completed)
        }
    }

    /// Shared worker for both BG tasks — scans PHAssets, filters backed-up,
    /// enqueues up to `maxAssets` uploads into bgSession. Does NOT wait for
    /// them to finish; bgSession runs them after we return.
    private func runBackgroundBackupSlice(
        serverUrl: String, authToken: String, userEmail: String,
        maxAssets: Int, timeoutSec: TimeInterval
    ) async -> Bool {
        shouldStop = false
        let start = Date()

        // Permission guard — if user revoked, bail fast.
        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }
        guard status == .authorized || status == .limited else { return false }

        let backedUpSet = Set(UserDefaults.standard.stringArray(forKey: "com.onemundo.backedUpAssets") ?? [])

        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = PHAsset.fetchAssets(with: opts)

        let origin: String = {
            if let q = serverUrl.firstIndex(of: "?") { return String(serverUrl[..<q]) }
            if serverUrl.hasSuffix("/api/email.php") {
                return String(serverUrl.dropLast("/api/email.php".count))
            }
            return serverUrl
        }()

        var uploaded = 0
        await withTaskGroup(of: Bool.self) { group in
            var cursor = 0
            var enqueued = 0
            let concurrency = 4 // gentle on background CPU
            var inFlight = 0

            while cursor < assets.count && enqueued < maxAssets && !shouldStop {
                if Date().timeIntervalSince(start) > timeoutSec { break }
                let asset = assets.object(at: cursor)
                cursor += 1
                if backedUpSet.contains(asset.localIdentifier) { continue }

                group.addTask {
                    return await self.chunkedUploadAsset(
                        asset: asset, origin: origin,
                        authToken: authToken, userEmail: userEmail
                    )
                }
                enqueued += 1
                inFlight += 1

                if inFlight >= concurrency {
                    if let ok = await group.next() {
                        inFlight -= 1
                        if ok { uploaded += 1 }
                    }
                }
            }
            for await ok in group { if ok { uploaded += 1 } }
        }
        return uploaded > 0 || shouldStop == false
    }

    /// JS calls this after login so we have credentials cached for when
    /// iOS wakes us up in the background (JS won't be running then).
    fileprivate func saveBackupCreds(serverUrl: String, authToken: String, userEmail: String) {
        let d = UserDefaults.standard
        d.set(serverUrl, forKey: "com.onemundo.backup.serverUrl")
        d.set(authToken, forKey: "com.onemundo.backup.authToken")
        d.set(userEmail, forKey: "com.onemundo.backup.userEmail")
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

// MARK: - PhotoLibraryObserver

/// Tiny NSObject wrapper so the Module class doesn't have to conform to
/// PHPhotoLibraryChangeObserver directly (Module's class hierarchy is
/// owned by ExpoModulesCore). We forward photoLibraryDidChange callbacks
/// to a Swift closure the module installs at OnCreate time.
private final class PhotoLibraryObserver: NSObject, PHPhotoLibraryChangeObserver {
    private let onChange: () -> Void
    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        super.init()
    }
    func photoLibraryDidChange(_ changeInstance: PHChange) {
        DispatchQueue.main.async { [weak self] in
            self?.onChange()
        }
    }
}
