//
//  SampleHandler.swift
//  ChatyyBroadcastExtension
//
//  [2026-10-15 screen-share whatsapp-level] ReplayKit Broadcast Upload
//  Extension — STANDALONE (no LiveKitClient / no pods in the appex).
//  Copied into ios/ChatyyBroadcastExtension/ by
//  plugins/with-broadcast-extension.js on every prebuild — edit it HERE.
//
//  WHY not `class SampleHandler: LKSampleHandler {}` any more:
//    * LKSampleHandler JPEG-encodes every frame at FULL native resolution
//      (iPhone 15 = 1179x2556) with quality 1.0 — 1-2 MB per frame plus the
//      CIContext intermediates, in a process iOS kills at 50 MB.
//    * Linking LiveKitClient drags LiveKitWebRTC.framework into the
//      extension process (dyld + ObjC realisation = several MB of dirty
//      memory for code we never run here).
//    * No connect timeout: started from Control Center outside a call the
//      broadcast sat "recording" forever with nobody listening.
//
//  WIRE PROTOCOL (must match LiveKit Swift 2.0.18 host side —
//  BroadcastServerSocketConnection + SocketConnectionFrameReader):
//    Unix stream socket at <App Group container>/rtc_SSFD (host listens,
//    we connect). One CFHTTPMessage (HTTP/1.1 200 response) per frame with
//    headers Content-Length, Buffer-Width, Buffer-Height, Buffer-Orientation
//    (CGImagePropertyOrientation raw value) and a JPEG body. The host builds
//    a BGRA CVPixelBuffer of Buffer-Width x Buffer-Height and renders the
//    JPEG into it, so we may send DOWNSCALED frames as long as the headers
//    carry the scaled size (LiveKit's own uploader does the same with its
//    scaleFactor).
//
//  BUDGET: long side <= 1920 (short <= 1080), <= 15 fps, JPEG q 0.85. A
//  footprint probe (task_vm_info.phys_footprint) every 2 s steps quality
//  down (1280 / 960, 10 / 8 fps) before the 50 MB jetsam line.
//
//  HOST <-> EXTENSION SIGNALS (Darwin notifications, cross-process):
//    iOS_BroadcastStarted  (we post)  — host publishes the screen track
//    iOS_BroadcastStopped  (we post)  — host unpublishes / resets UI
//    com.chatyy.screenshare.hoststop (host posts) — user tapped "Parar" in
//      the app or hung up: finish immediately (no reconnect grace).
//  Stats for voip_diag go to App Group defaults "chatyy_ss_ext_stats"
//  (host logs them as screen_share_ext_stats when the share ends).
//

import CoreImage
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ImageIO
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler {

    // MARK: - Constants

    private static let fallbackAppGroup = "group.com.onemundo.mail"
    private static let socketFileName = "rtc_SSFD"           // = BroadcastScreenCapturer.kRTCScreensharingSocketFD
    private static let startedName = "iOS_BroadcastStarted"
    private static let stoppedName = "iOS_BroadcastStopped"
    private static let hostStopName = "com.chatyy.screenshare.hoststop"
    private static let statsKey = "chatyy_ss_ext_stats"

    /// Give the host this long to publish + listen after "started" (it only
    /// publishes once it hears iOS_BroadcastStarted; a slow SFU round trip
    /// is ~1-3 s). Outside a call nobody ever listens → friendly error.
    private static let connectTimeout: CFTimeInterval = 20
    /// Socket dropped WITHOUT a host "stop" signal (LiveKit reconnect
    /// republishing the track, host capturer restart): try to re-attach
    /// this long before ending the broadcast.
    private static let reconnectGrace: CFTimeInterval = 6
    /// A single frame write that cannot complete within this window counts
    /// as a stall; this many seconds of continuous stall ends the broadcast.
    private static let maxStall: CFTimeInterval = 12

    // MARK: - State (all mutated on `queue` unless noted)

    private let queue = DispatchQueue(label: "com.chatyy.broadcast.uploader", qos: .userInitiated)
    private var fd: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var connectTimer: DispatchSourceTimer?
    private var memTimer: DispatchSourceTimer?
    private var connectDeadline: CFTimeInterval = 0
    private var everConnected = false
    private var finished = false
    private var hostStopRequested = false
    private var stallSince: CFTimeInterval = 0

    /// Frame gate — set from the ReplayKit callback thread, cleared on queue.
    private let busyLock = NSLock()
    private var busy = false
    private var lastFrameAt: CFTimeInterval = 0

    // Adaptive budget (read on the ReplayKit thread, written on queue: guarded).
    private let budgetLock = NSLock()
    private var maxLongSide: CGFloat = 1920
    private var maxShortSide: CGFloat = 1080
    private var minFrameInterval: CFTimeInterval = 1.0 / 15.0
    /// [2026-10-15 screen-share sharpness] 0.7 → 0.85: the JPEG is only the
    /// extension→app hop (unix socket, no network cost) but its ringing /
    /// chroma blur on small text survives the VP8 re-encode. Field data:
    /// peakMB=27.8 at 884x1918 q0.7 — the size of the JPEG body barely
    /// moves the footprint (CIContext intermediates dominate).
    private var jpegQuality: CGFloat = 0.85

    // Stats
    private var framesSent = 0
    private var framesDropped = 0
    private var peakMB: Double = 0
    private var lastW = 0
    private var lastH = 0
    private var startedAt: CFTimeInterval = 0

    private let ciContext = CIContext(options: [
        .cacheIntermediates: false,
        .useSoftwareRenderer: false,
    ])
    private let rgb = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()

    private var appGroup: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String
        return (v?.isEmpty == false) ? v! : SampleHandler.fallbackAppGroup
    }

    private var socketPath: String? {
        guard let c = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        return c.appendingPathComponent(SampleHandler.socketFileName).path
    }

    // MARK: - RPBroadcastSampleHandler

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        startedAt = CACurrentMediaTime()
        installHostStopObserver()
        postDarwin(SampleHandler.startedName)
        queue.async { [weak self] in
            guard let self = self else { return }
            self.connectDeadline = CACurrentMediaTime() + SampleHandler.connectTimeout
            self.startConnectLoop()
            self.startMemoryProbe()
        }
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        // User stopped from the red status pill / Control Center.
        queue.sync { self.teardown(reason: "user_finished") }
        postDarwin(SampleHandler.stoppedName)
        removeHostStopObserver()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        // Only the screen. App/mic audio is never forwarded (WhatsApp parity:
        // iOS screen share carries no system audio).
        guard sampleBufferType == .video else { return }

        let now = CACurrentMediaTime()
        budgetLock.lock()
        let interval = minFrameInterval
        budgetLock.unlock()

        busyLock.lock()
        if busy || fd < 0 || now - lastFrameAt < interval {
            busyLock.unlock()
            framesDropped &+= 1
            return
        }
        busy = true
        lastFrameAt = now
        busyLock.unlock()

        // Encode on the ReplayKit thread (the sample buffer is only valid
        // here without an extra retain of the IOSurface pool), send on queue.
        let message: Data? = autoreleasepool { encode(sampleBuffer) }
        guard let data = message else {
            clearBusy()
            return
        }
        queue.async { [weak self] in
            guard let self = self else { return }
            self.send(data)
            self.clearBusy()
        }
    }

    // MARK: - Encoding

    private func encode(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        let srcW = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
        let srcH = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
        guard srcW > 0, srcH > 0 else { return nil }

        budgetLock.lock()
        let longCap = maxLongSide
        let shortCap = maxShortSide
        let quality = jpegQuality
        budgetLock.unlock()

        let longSide = max(srcW, srcH)
        let shortSide = min(srcW, srcH)
        let scale = min(1.0, longCap / longSide, shortCap / shortSide)
        // Even integer target size → the JPEG extent is exactly what the
        // Buffer-Width/Height headers announce.
        let dstW = max(2, Int((srcW * scale / 2).rounded(.down)) * 2)
        let dstH = max(2, Int((srcH * scale / 2).rounded(.down)) * 2)
        let sx = CGFloat(dstW) / srcW
        let sy = CGFloat(dstH) / srcH

        var image = CIImage(cvPixelBuffer: pixelBuffer)
        if sx < 0.999 || sy < 0.999 {
            image = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        }
        let space = image.colorSpace ?? rgb
        let opts: [CIImageRepresentationOption: Any] = [
            kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: Float(quality),
        ]
        guard let jpeg = ciContext.jpegRepresentation(of: image, colorSpace: space, options: opts) else { return nil }

        let orientation: UInt32 = {
            if let n = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber {
                return n.uint32Value
            }
            return 1   // .up
        }()

        let msg = CFHTTPMessageCreateResponse(kCFAllocatorDefault, 200, nil, kCFHTTPVersion1_1).takeRetainedValue()
        CFHTTPMessageSetHeaderFieldValue(msg, "Content-Length" as CFString, String(jpeg.count) as CFString)
        CFHTTPMessageSetHeaderFieldValue(msg, "Buffer-Width" as CFString, String(dstW) as CFString)
        CFHTTPMessageSetHeaderFieldValue(msg, "Buffer-Height" as CFString, String(dstH) as CFString)
        CFHTTPMessageSetHeaderFieldValue(msg, "Buffer-Orientation" as CFString, String(orientation) as CFString)
        CFHTTPMessageSetBody(msg, jpeg as CFData)
        lastW = dstW
        lastH = dstH
        return CFHTTPMessageCopySerializedMessage(msg)?.takeRetainedValue() as Data?
    }

    private func clearBusy() {
        busyLock.lock()
        busy = false
        busyLock.unlock()
    }

    // MARK: - Socket (queue only)

    private func startConnectLoop() {
        guard !finished, connectTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .milliseconds(200), leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in
            guard let self = self else { return }
            if self.finished { self.stopConnectLoop(); return }
            if self.tryConnect() {
                self.stopConnectLoop()
                return
            }
            if CACurrentMediaTime() > self.connectDeadline {
                self.stopConnectLoop()
                let reason = self.everConnected ? "reconnect_timeout" : "connect_timeout"
                self.finish(reason: reason,
                            message: self.everConnected ? SampleHandler.text("stopped") : SampleHandler.text("notInCall"))
            }
        }
        connectTimer = t
        t.resume()
    }

    private func stopConnectLoop() {
        connectTimer?.cancel()
        connectTimer = nil
    }

    private func tryConnect() -> Bool {
        guard let path = socketPath, FileManager.default.fileExists(atPath: path) else { return false }
        let s = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return false }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < maxLen else { Darwin.close(s); return false }
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: CChar.self, capacity: maxLen) { dst in
                path.withCString { src in strncpy(dst, src, maxLen - 1) }
            }
        }
        let rc = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else { Darwin.close(s); return false }

        var one: Int32 = 1
        _ = setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        _ = setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        fd = s
        everConnected = true
        stallSince = 0

        // Host closing the socket (stop / hang-up / capturer restart) shows
        // up as EOF even when the screen is static and no frame is written.
        let src = DispatchSource.makeReadSource(fileDescriptor: s, queue: queue)
        src.setEventHandler { [weak self] in
            guard let self = self else { return }
            var b: UInt8 = 0
            let n = Darwin.read(s, &b, 1)
            if n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR) {
                self.socketLost(reason: n == 0 ? "host_closed" : "read_error")
            }
        }
        src.setCancelHandler { Darwin.close(s) }
        readSource = src
        src.resume()
        return true
    }

    private func closeSocket() {
        if let src = readSource {
            readSource = nil
            src.cancel()          // cancel handler closes the fd
        } else if fd >= 0 {
            Darwin.close(fd)
        }
        fd = -1
    }

    private func send(_ data: Data) {
        guard fd >= 0, !finished else { return }
        let ok: Bool = data.withUnsafeBytes { raw -> Bool in
            guard var p = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return false }
            var left = raw.count
            while left > 0 {
                let n = Darwin.write(fd, p, left)
                if n > 0 {
                    left -= n
                    p = p.advanced(by: n)
                    continue
                }
                if n < 0 && errno == EINTR { continue }
                if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    // SO_SNDTIMEO hit: host not draining (suspended / busy).
                    let now = CACurrentMediaTime()
                    if stallSince == 0 { stallSince = now }
                    if now - stallSince > SampleHandler.maxStall {
                        socketLost(reason: "stall")
                    }
                    // A half-written message would desync the host's HTTP
                    // framing — the socket must be dropped and re-attached.
                    if left < raw.count { socketLost(reason: "partial_write") }
                    return false
                }
                socketLost(reason: "write_error_\(errno)")
                return false
            }
            return true
        }
        if ok {
            stallSince = 0
            framesSent &+= 1
        } else {
            framesDropped &+= 1
        }
    }

    /// Connection gone. Host-initiated stop → end now; otherwise give the
    /// host a short grace window to listen again (LiveKit republish).
    private func socketLost(reason: String) {
        guard fd >= 0 || readSource != nil else { return }
        closeSocket()
        if finished { return }
        if hostStopRequested {
            finish(reason: "host_stop", message: SampleHandler.text("stopped"))
            return
        }
        connectDeadline = CACurrentMediaTime() + SampleHandler.reconnectGrace
        lastLossReason = reason
        startConnectLoop()
    }
    private var lastLossReason = ""

    // MARK: - Memory probe

    private func startMemoryProbe() {
        guard memTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: .seconds(2), leeway: .milliseconds(200))
        t.setEventHandler { [weak self] in self?.memoryTick() }
        memTimer = t
        t.resume()
    }

    private func memoryTick() {
        let mb = SampleHandler.footprintMB()
        guard mb > 0 else { return }
        if mb > peakMB { peakMB = mb }
        budgetLock.lock()
        if mb > 42 {
            maxLongSide = 960; maxShortSide = 540; minFrameInterval = 1.0 / 8.0; jpegQuality = 0.65
        } else if mb > 34 {
            if maxLongSide > 1280 {
                maxLongSide = 1280; maxShortSide = 720; minFrameInterval = 1.0 / 10.0; jpegQuality = 0.75
            }
        }
        budgetLock.unlock()
        if mb > 34 { ciContext.clearCaches() }
    }

    private static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return -1 }
        return Double(info.phys_footprint) / 1_048_576.0
    }

    // MARK: - Finish / teardown

    /// End the broadcast from the extension side (removes the red pill).
    private func finish(reason: String, message: String) {
        guard !finished else { return }
        teardown(reason: reason)
        postDarwin(SampleHandler.stoppedName)
        let err = NSError(domain: RPRecordingErrorDomain, code: 10001,
                          userInfo: [NSLocalizedDescriptionKey: message])
        DispatchQueue.main.async { [weak self] in
            self?.removeHostStopObserver()
            self?.finishBroadcastWithError(err)
        }
    }

    private func teardown(reason: String) {
        guard !finished else { return }
        finished = true
        stopConnectLoop()
        memTimer?.cancel()
        memTimer = nil
        closeSocket()
        writeStats(reason: reason)
    }

    private func jpegQualityNow() -> CGFloat {
        budgetLock.lock(); defer { budgetLock.unlock() }
        return jpegQuality
    }

    private func writeStats(reason: String) {
        let dur = startedAt > 0 ? CACurrentMediaTime() - startedAt : 0
        let stats: [String: Any] = [
            "reason": reason,
            "lastLoss": lastLossReason,
            "sent": framesSent,
            "dropped": framesDropped,
            "peakMB": (peakMB * 10).rounded() / 10,
            "w": lastW,
            "h": lastH,
            "q": Double((jpegQualityNow() * 100).rounded()) / 100,
            "durS": Int(dur),
            "connected": everConnected,
            "at": Date().timeIntervalSince1970,
        ]
        UserDefaults(suiteName: appGroup)?.set(stats, forKey: SampleHandler.statsKey)
    }

    // MARK: - Darwin notifications

    private func postDarwin(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(rawValue: name as CFString), nil, nil, true)
    }

    private var hostStopObserving = false

    private func installHostStopObserver() {
        guard !hostStopObserving else { return }
        hostStopObserving = true
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            { (_, observer, _, _, _) in
                guard let observer = observer else { return }
                let me = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
                me.queue.async {
                    me.hostStopRequested = true
                    if me.finished { return }
                    me.finish(reason: "host_stop", message: SampleHandler.text("stopped"))
                }
            },
            SampleHandler.hostStopName as CFString,
            nil,
            .deliverImmediately
        )
    }

    private func removeHostStopObserver() {
        guard hostStopObserving else { return }
        hostStopObserving = false
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(),
                                                Unmanaged.passUnretained(self).toOpaque())
    }

    deinit {
        if hostStopObserving {
            CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(),
                                                    Unmanaged.passUnretained(self).toOpaque())
        }
    }

    // MARK: - Strings (11 app languages; app language mirrored in the App Group)

    private static let strings: [String: [String: String]] = [
        "pt-BR": ["notInCall": "Abra uma chamada no Chatyy para compartilhar a tela.", "stopped": "Compartilhamento de tela encerrado."],
        "pt-PT": ["notInCall": "Abra uma chamada no Chatyy para partilhar o ecrã.", "stopped": "Partilha de ecrã terminada."],
        "en": ["notInCall": "Start a call in Chatyy to share your screen.", "stopped": "Screen sharing ended."],
        "es": ["notInCall": "Abre una llamada en Chatyy para compartir la pantalla.", "stopped": "Se dejó de compartir la pantalla."],
        "fr": ["notInCall": "Lancez un appel dans Chatyy pour partager votre écran.", "stopped": "Partage d’écran terminé."],
        "de": ["notInCall": "Starte einen Anruf in Chatyy, um deinen Bildschirm zu teilen.", "stopped": "Bildschirmfreigabe beendet."],
        "it": ["notInCall": "Avvia una chiamata in Chatyy per condividere lo schermo.", "stopped": "Condivisione schermo terminata."],
        "ja": ["notInCall": "画面を共有するには Chatyy で通話を開始してください。", "stopped": "画面共有を終了しました。"],
        "ar": ["notInCall": "ابدأ مكالمة في Chatyy لمشاركة شاشتك.", "stopped": "تم إيقاف مشاركة الشاشة."],
        "id": ["notInCall": "Mulai panggilan di Chatyy untuk membagikan layar.", "stopped": "Berbagi layar dihentikan."],
        "hi": ["notInCall": "स्क्रीन शेयर करने के लिए Chatyy में कॉल शुरू करें।", "stopped": "स्क्रीन शेयरिंग बंद हो गई।"],
    ]

    private static func text(_ key: String) -> String {
        let group = (Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") as? String) ?? fallbackAppGroup
        let raw = UserDefaults(suiteName: group)?.string(forKey: "chatyy_app_lang")
            ?? Locale.preferredLanguages.first ?? "en"
        let l = normalize(raw)
        return strings[l]?[key] ?? strings["en"]?[key] ?? key
    }

    private static func normalize(_ code: String) -> String {
        let c = code.replacingOccurrences(of: "_", with: "-").lowercased()
        if c.hasPrefix("pt-pt") || c == "pt-ao" || c == "pt-mz" { return "pt-PT" }
        if c.hasPrefix("pt") { return "pt-BR" }
        for l in ["en", "es", "fr", "de", "it", "ja", "ar", "id", "hi"] where c.hasPrefix(l) { return l }
        if c.hasPrefix("in") { return "id" }
        return "en"
    }
}
