import ExpoModulesCore
import Photos
import UIKit

struct UploadRequest: Record {
    @Field var assetId: String = ""
    @Field var presignedUrl: String = ""
    @Field var mimeType: String = "image/jpeg"
    @Field var maxWidth: Int = 0
    @Field var maxHeight: Int = 0
}

struct BackupConfig: Record {
    @Field var serverUrl: String = ""
    @Field var authToken: String = ""
    @Field var backedUpIds: [String] = []
}

public class ExpoBackgroundUploadModule: Module {

    private let phManager = PHCachingImageManager()
    private var isRunning = false
    private var shouldStop = false
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid

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
        Events("onProgress", "onComplete", "onBatchComplete")

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

        // Start full backup - does everything natively (copy + upload) without returning to JS
        // Uses beginBackgroundTask for extra time when app goes to background
        AsyncFunction("startNativeBackup") { (serverUrl: String, authToken: String) -> [String: Any] in
            if self.isRunning { return ["error": "already_running"] }
            self.isRunning = true
            self.shouldStop = false

            // Request background time from iOS (30s - 4 minutes)
            self.bgTaskId = await UIApplication.shared.beginBackgroundTask {
                // iOS is about to kill us - stop gracefully
                self.shouldStop = true
                if self.bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(self.bgTaskId)
                    self.bgTaskId = .invalid
                }
            }

            var uploaded = 0
            var total = 0

            defer {
                self.isRunning = false
                if self.bgTaskId != .invalid {
                    UIApplication.shared.endBackgroundTask(self.bgTaskId)
                    self.bgTaskId = .invalid
                }
            }

            // Get backed up IDs from UserDefaults
            let backedUpKey = "com.onemundo.backedUpAssets"
            let backedUpSet = Set(UserDefaults.standard.stringArray(forKey: backedUpKey) ?? [])
            var newBackedUp = backedUpSet

            // Scan photos in batches of 50
            let fetchOptions = PHFetchOptions()
            fetchOptions.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let allAssets = PHAsset.fetchAssets(with: .image, options: fetchOptions)
            total = allAssets.count

            var processed = 0

            // Process in chunks - copy file + create upload task for each
            allAssets.enumerateObjects { (asset, index, stop) in
                if self.shouldStop {
                    stop.pointee = true
                    return
                }

                let assetId = asset.localIdentifier
                if backedUpSet.contains(assetId) { return } // already backed up

                processed += 1
            }

            // Now do the actual work with async
            var cursor = 0
            while cursor < allAssets.count && !shouldStop {
                let asset = allAssets.object(at: cursor)
                cursor += 1

                let assetId = asset.localIdentifier
                if backedUpSet.contains(assetId) { continue }

                do {
                    // Copy photo to temp file
                    let tempFile = try await copyAssetToFile(asset: asset)

                    // Upload via Node.js endpoint (fast, no PHP workers)
                    let uploadUrl = serverUrl.replacingOccurrences(of: "/api/email.php", with: "/upload-photo")
                    try createMultipartUploadTask(
                        url: uploadUrl,
                        fileUrl: tempFile,
                        authToken: authToken,
                        filename: asset.originalFilename ?? "photo.jpg",
                        mimeType: "image/jpeg",
                        assetId: assetId
                    )

                    newBackedUp.insert(assetId)
                    uploaded += 1

                    // Report progress every 10
                    if uploaded % 10 == 0 {
                        self.sendEvent("onProgress", [
                            "uploaded": uploaded, "total": total, "assetId": assetId
                        ])
                        // Save progress
                        UserDefaults.standard.set(Array(newBackedUp), forKey: backedUpKey)
                    }
                } catch {
                    // Skip this photo, continue with next
                }
            }

            // Final save
            UserDefaults.standard.set(Array(newBackedUp), forKey: backedUpKey)

            return ["uploaded": uploaded, "total": total, "stopped": shouldStop]
        }

        Function("stopBackup") {
            self.shouldStop = true
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

        // Reset backed up IDs (for testing)
        Function("resetBackedUpIds") {
            UserDefaults.standard.removeObject(forKey: "com.onemundo.backedUpAssets")
        }

        // Get backed up count
        Function("getBackedUpCount") { () -> Int in
            return UserDefaults.standard.stringArray(forKey: "com.onemundo.backedUpAssets")?.count ?? 0
        }
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

                let ext = (uti ?? "").contains("heic") ? "heic" : ((uti ?? "").contains("png") ? "png" : "jpg")
                let fileName = UUID().uuidString + "." + ext
                let fileUrl = self.uploadDir.appendingPathComponent(fileName)

                do {
                    try data.write(to: fileUrl, options: [.atomic])
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
