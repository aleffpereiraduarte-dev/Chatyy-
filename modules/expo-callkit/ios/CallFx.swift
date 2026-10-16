// CallFx.swift — [2026-10-16 wave13-B] EFEITOS EM CHAMADA (nível FaceTime/WhatsApp).
//
// Fundo (nenhum · desfoque leve/forte · 8 fundos P&B gerados no aparelho ·
// foto da galeria) + luz (retoque · pouca luz), aplicados NOS FRAMES DA CÂMERA
// antes do encoder LiveKit — o outro lado vê, e o PiP local mostra ao vivo.
//
// Por que um "tap" no AVCaptureVideoDataOutput: o LiveKitClient 2.0.18 NÃO tem
// gancho de VideoProcessor para a câmera (VideoCapturer._processFrame só
// entrega frames a renderers/fonte; ver o comentário de 2026-10-11 em
// presentMoreMenu). Mas `CameraCapturer.captureSession` é público e o
// LKRTCCameraVideoCapturer (WebRTC m125) recebe os frames como
// AVCaptureVideoDataOutputSampleBufferDelegate. Trocamos o delegate daquele
// output por CallFxCaptureTap (mesma fila serial), que processa o
// CVPixelBuffer e repassa um CMSampleBuffer novo (mesmo PTS + anexos) ao
// delegate original. Rotação/timestamp/espelho continuam sendo calculados
// pelo WebRTC exatamente como antes. Sem efeito → o sample original passa
// direto (custo zero).
//
// Segmentação: Vision VNGeneratePersonSegmentationRequest (iOS 15+, embutido,
// sem dependência). Request reaproveitado entre frames (suavização temporal
// do próprio Vision). Composição CoreImage na GPU (CIBlendWithMask).
//
// Desempenho: no máx. 30 fps (frames acima disso são descartados com efeito
// ligado); qualidade .balanced → .fast se o frame passar de ~28 ms ou o
// aparelho esquentar (.fair); máscara a cada 2 frames se passar de ~40 ms.
// Auto-pausa (passa direto, escolha mantida) com térmico .serious/.critical,
// Modo Pouca Energia ou bateria < 15 % fora da tomada; volta sozinho.
//
// Kill switch: App Group "call_fx_enabled" = false (ExpoCallKit
// .setCallEffectsEnabled(false), espelhado do JS
// globalThis.__chatyy_call_fx === false) → nenhum tap é instalado e a linha
// "Efeitos" some. Escolha persistida: "call_fx_bg" / "call_fx_light".
//
// Threading: config (fundo/luz/pausa) sob `cfgLock`; o processamento roda na
// fila de captura do WebRTC sob `procLock` (try — se dois capturers
// coexistirem por um instante, o segundo passa direto). UI/observers só na
// main. Nada aqui é @MainActor para não exigir hop na fila de captura.

import Foundation
import UIKit
import AVFoundation
import CoreImage
import Metal
import CoreMedia
import CoreVideo
import Vision
import PhotosUI
import ObjectiveC
import LiveKitClient

// MARK: - Model

enum CallFxBackground: Equatable {
    case none
    case blurLight
    case blurStrong
    case wallpaper(Int)
    case custom

    var key: String {
        switch self {
        case .none: return "none"
        case .blurLight: return "blur_light"
        case .blurStrong: return "blur_strong"
        case .wallpaper(let i): return "wp:\(i)"
        case .custom: return "custom"
        }
    }

    static func from(_ key: String?) -> CallFxBackground {
        guard let k = key, !k.isEmpty else { return .none }
        switch k {
        case "blur_light": return .blurLight
        case "blur_strong": return .blurStrong
        case "custom": return .custom
        default:
            if k.hasPrefix("wp:"), let i = Int(k.dropFirst(3)), i >= 0, i < CallFxWallpapers.count {
                return .wallpaper(i)
            }
            return .none
        }
    }
}

enum CallFxLight: String {
    case none = "none"
    case retouch = "retouch"
    case lowLight = "low_light"
}

enum CallFxPauseReason: String {
    case none = ""
    case heat = "heat"
    case battery = "battery"
}

// MARK: - Engine

final class CallFx: NSObject, @unchecked Sendable {
    static let shared = CallFx()

    static let pauseChangedNotification = Notification.Name("ChatyyCallFxPauseChanged")
    static let configChangedNotification = Notification.Name("ChatyyCallFxConfigChanged")

    private static let appGroup = "group.com.onemundo.mail"
    private static let kEnabled = "call_fx_enabled"
    private static let kBg = "call_fx_bg"
    private static let kLight = "call_fx_light"
    private static let customFileName = "call_fx_custom_bg.jpg"

    // ── config (cfgLock) ──
    private let cfgLock = NSLock()
    private var cfgBackground: CallFxBackground = .none
    private var cfgLight: CallFxLight = .none
    private var cfgPause: CallFxPauseReason = .none
    private var cfgEnabled: Bool = true
    private var cfgCustomVersion: Int = 0
    private var cfgInterfaceOrientation: UIInterfaceOrientation = .portrait
    private var cfgThermalFair: Bool = false

    // ── processing (procLock, capture queue) ──
    private let procLock = NSLock()
    private lazy var ciContext: CIContext = {
        if let dev = MTLCreateSystemDefaultDevice() {
            return CIContext(mtlDevice: dev, options: [.cacheIntermediates: false])
        }
        return CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])
    }()
    private var segRequest: VNGeneratePersonSegmentationRequest?
    private var segQualityFast = false
    private var segEvery = 1
    private var frameIndex: UInt64 = 0
    private var lastMask: CIImage?
    private var lastMaskExtent: CGRect = .zero
    private var lastMaskBuffer: CVPixelBuffer?
    private var pool: CVPixelBufferPool?
    private var poolW = 0, poolH = 0
    private var poolFmt: OSType = 0
    private var fmtDesc: CMVideoFormatDescription?
    private var emaMs: Double = 0
    private var lastForwardPts: Double = -1
    private var wallpaperCache: [String: CIImage] = [:]
    private var customCache: (key: String, image: CIImage)?
    private var customSource: CIImage?
    private var customSourceVersion: Int = -1

    // ── monitoring (main) ──
    private var monitoring = false

    private override init() {
        super.init()
        let ud = UserDefaults(suiteName: CallFx.appGroup)
        cfgEnabled = (ud?.object(forKey: CallFx.kEnabled) as? Bool) ?? true
        cfgBackground = CallFxBackground.from(ud?.string(forKey: CallFx.kBg))
        cfgLight = CallFxLight(rawValue: ud?.string(forKey: CallFx.kLight) ?? "none") ?? .none
        if case .custom = cfgBackground, !FileManager.default.fileExists(atPath: CallFx.customFileURL.path) {
            cfgBackground = .none
        }
    }

    // MARK: Public config API (any thread; UI calls from main)

    var isEnabled: Bool { cfgLock.lock(); defer { cfgLock.unlock() }; return cfgEnabled }
    var background: CallFxBackground { cfgLock.lock(); defer { cfgLock.unlock() }; return cfgBackground }
    var light: CallFxLight { cfgLock.lock(); defer { cfgLock.unlock() }; return cfgLight }
    var pauseReason: CallFxPauseReason { cfgLock.lock(); defer { cfgLock.unlock() }; return cfgPause }

    /// Kill switch (JS/OTA → ExpoCallKit.setCallEffectsEnabled). OFF = taps
    /// already installed pass frames straight through; no new taps.
    func setEnabled(_ on: Bool) {
        cfgLock.lock(); cfgEnabled = on; cfgLock.unlock()
        UserDefaults(suiteName: CallFx.appGroup)?.set(on, forKey: CallFx.kEnabled)
        postConfigChanged()
    }

    func setBackground(_ bg: CallFxBackground) {
        cfgLock.lock(); cfgBackground = bg; cfgLock.unlock()
        UserDefaults(suiteName: CallFx.appGroup)?.set(bg.key, forKey: CallFx.kBg)
        postConfigChanged()
    }

    func setLight(_ l: CallFxLight) {
        cfgLock.lock(); cfgLight = l; cfgLock.unlock()
        UserDefaults(suiteName: CallFx.appGroup)?.set(l.rawValue, forKey: CallFx.kLight)
        postConfigChanged()
    }

    var hasCustomImage: Bool { FileManager.default.fileExists(atPath: CallFx.customFileURL.path) }

    static var customFileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent(customFileName)
    }

    /// Saves a gallery photo (downscaled, JPEG) and selects it.
    func saveCustomImage(_ image: UIImage) -> Bool {
        let maxSide: CGFloat = 1600
        let sz = image.size
        let scale = min(1, maxSide / max(sz.width, sz.height, 1))
        let target = CGSize(width: max(1, floor(sz.width * scale)), height: max(1, floor(sz.height * scale)))
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1
        let img = UIGraphicsImageRenderer(size: target, format: fmt).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let data = img.jpegData(compressionQuality: 0.85) else { return false }
        do {
            let url = CallFx.customFileURL
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            NSLog("[CallFx] save custom bg failed: \(error)")
            return false
        }
        cfgLock.lock(); cfgCustomVersion += 1; cfgLock.unlock()
        setBackground(.custom)
        return true
    }

    private func postConfigChanged() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: CallFx.configChangedNotification, object: nil)
        }
    }

    // MARK: Attach

    private static var tapKey: UInt8 = 0

    /// Install the frame tap on the camera capturer behind `track`
    /// (idempotent per AVCaptureVideoDataOutput). Call on main whenever a
    /// local camera track appears (publish, re-publish, ring preview).
    func attach(_ track: LocalVideoTrack?) {
        guard isEnabled, let track = track, let cam = track.capturer as? CameraCapturer else { return }
        startMonitoringIfNeeded()
        refreshInterfaceOrientation()
        let session = cam.captureSession
        var installed = 0
        for case let out as AVCaptureVideoDataOutput in session.outputs {
            if objc_getAssociatedObject(out, &CallFx.tapKey) != nil { continue }
            guard let orig = out.sampleBufferDelegate, let q = out.sampleBufferCallbackQueue else { continue }
            if orig is CallFxCaptureTap { continue }
            let tap = CallFxCaptureTap(original: orig)
            objc_setAssociatedObject(out, &CallFx.tapKey, tap, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            out.setSampleBufferDelegate(tap, queue: q)
            installed += 1
        }
        if installed > 0 { NSLog("[CallFx] tap installed on \(installed) output(s)") }
    }

    // MARK: Monitoring (thermal / battery / low power / orientation)

    private func startMonitoringIfNeeded() {
        guard !monitoring else { return }
        monitoring = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(evaluatePause), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(evaluatePause), name: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil)
        nc.addObserver(self, selector: #selector(evaluatePause), name: UIDevice.batteryLevelDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(evaluatePause), name: UIDevice.batteryStateDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(orientationDidChange), name: UIDevice.orientationDidChangeNotification, object: nil)
        evaluatePause()
    }

    @objc private func orientationDidChange() {
        // Scene orientation settles a beat after the device notification.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.refreshInterfaceOrientation() }
    }

    private func refreshInterfaceOrientation() {
        let run = { [weak self] in
            guard let self = self else { return }
            let scene = UIApplication.shared.connectedScenes.first(where: { $0 is UIWindowScene }) as? UIWindowScene
            let o = scene?.interfaceOrientation ?? .portrait
            self.cfgLock.lock(); self.cfgInterfaceOrientation = o; self.cfgLock.unlock()
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }

    @objc private func evaluatePause() {
        let run = { [weak self] in
            guard let self = self else { return }
            let pi = ProcessInfo.processInfo
            let thermal = pi.thermalState
            let dev = UIDevice.current
            let level = dev.batteryLevel // -1 when unknown
            let unplugged = dev.batteryState == .unplugged
            let lowBattery = pi.isLowPowerModeEnabled || (unplugged && level >= 0 && level < 0.15)
            let recoveredBattery = !pi.isLowPowerModeEnabled && (!unplugged || level < 0 || level >= 0.20)

            self.cfgLock.lock()
            let prev = self.cfgPause
            var next = prev
            if thermal == .serious || thermal == .critical {
                next = .heat
            } else if lowBattery {
                next = .battery
            } else if prev == .heat {
                // Hysteresis: resume only once back to nominal/fair.
                next = (thermal == .nominal || thermal == .fair) ? .none : .heat
            } else if prev == .battery {
                next = recoveredBattery ? .none : .battery
            }
            self.cfgPause = next
            self.cfgThermalFair = (thermal == .fair)
            self.cfgLock.unlock()

            if next != prev {
                NSLog("[CallFx] pause \(prev.rawValue.isEmpty ? "-" : prev.rawValue) → \(next.rawValue.isEmpty ? "-" : next.rawValue) thermal=\(thermal.rawValue) lpm=\(pi.isLowPowerModeEnabled) batt=\(level)")
                NotificationCenter.default.post(name: CallFx.pauseChangedNotification, object: nil,
                                                userInfo: ["reason": next.rawValue])
            }
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }

    /// Toast text for the current pause (nil = not paused).
    static func pauseToastText(_ r: CallFxPauseReason) -> String? {
        switch r {
        case .heat: return CallFxStrings.s("pausedHeat")
        case .battery: return CallFxStrings.s("pausedBattery")
        case .none: return nil
        }
    }

    // MARK: Per-frame processing (capture queue)

    /// Snapshot read once per frame.
    private struct Snapshot {
        let bg: CallFxBackground
        let light: CallFxLight
        let orientation: UIInterfaceOrientation
        let thermalFair: Bool
        let customVersion: Int
        var active: Bool { !(bg == .none && light == .none) }
    }

    private func snapshot() -> Snapshot? {
        cfgLock.lock(); defer { cfgLock.unlock() }
        guard cfgEnabled, cfgPause == .none else { return nil }
        return Snapshot(bg: cfgBackground, light: cfgLight, orientation: cfgInterfaceOrientation,
                        thermalFair: cfgThermalFair, customVersion: cfgCustomVersion)
    }

    /// Decide what to do with a camera sample. Returns:
    ///   .passThrough  → forward the original sample
    ///   .drop         → forward nothing (fps cap)
    ///   .replace(sb)  → forward the processed sample
    enum Outcome {
        case passThrough
        case drop
        case replace(CMSampleBuffer)
    }

    func handle(sampleBuffer sb: CMSampleBuffer, connection: AVCaptureConnection) -> Outcome {
        guard let snap = snapshot(), snap.active else { return .passThrough }
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return .passThrough }
        guard procLock.try() else { return .passThrough }
        defer { procLock.unlock() }

        // ≤ 30 fps while an effect is on (camera may deliver 60 in Full HD).
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        if pts.isFinite, lastForwardPts >= 0, pts > lastForwardPts, pts - lastForwardPts < (1.0 / 31.0) {
            return .drop
        }

        let t0 = CACurrentMediaTime()
        let front = CallFx.isFrontCamera(sampleBuffer: sb, connection: connection)
        let ori = CallFx.uprightOrientation(interface: snap.orientation, front: front)
        guard let outPB = process(pb, orientation: ori, snap: snap),
              let outSB = CallFx.makeSampleBuffer(from: outPB, like: sb, cachedDesc: &fmtDesc) else {
            return .passThrough
        }
        let ms = (CACurrentMediaTime() - t0) * 1000
        emaMs = emaMs == 0 ? ms : (emaMs * 0.9 + ms * 0.1)
        adaptQuality(thermalFair: snap.thermalFair)
        if pts.isFinite { lastForwardPts = pts }
        return .replace(outSB)
    }

    private func adaptQuality(thermalFair: Bool) {
        let wantFast = thermalFair || emaMs > 28
        if wantFast != segQualityFast {
            // Hysteresis on the way back up.
            if wantFast || emaMs < 18 {
                segQualityFast = wantFast
                segRequest?.qualityLevel = wantFast ? .fast : .balanced
            }
        }
        if emaMs > 40 { segEvery = 2 } else if emaMs < 26 { segEvery = 1 }
    }

    private func process(_ pb: CVPixelBuffer, orientation ori: CGImagePropertyOrientation, snap: Snapshot) -> CVPixelBuffer? {
        frameIndex &+= 1
        let src = CIImage(cvPixelBuffer: pb)
        var up = src.oriented(ori)
        up = up.transformed(by: CGAffineTransform(translationX: -up.extent.origin.x, y: -up.extent.origin.y))
        let ext = up.extent
        guard ext.width >= 16, ext.height >= 16 else { return nil }

        var person = up
        switch snap.light {
        case .none: break
        case .retouch: person = applyRetouch(person, extent: ext)
        case .lowLight: person = applyLowLight(person, extent: ext)
        }

        var composed = person
        if snap.bg != .none {
            guard let mask = personMask(up, extent: ext) else { return nil }
            let backdrop: CIImage?
            switch snap.bg {
            case .none: backdrop = nil
            case .blurLight: backdrop = blurred(person, extent: ext, sigma: 9)
            case .blurStrong: backdrop = blurred(person, extent: ext, sigma: 22)
            case .wallpaper(let i): backdrop = wallpaperImage(index: i, extent: ext)
            case .custom: backdrop = customImage(extent: ext, version: snap.customVersion)
            }
            if let bgImage = backdrop {
                composed = person.applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: bgImage,
                    kCIInputMaskImageKey: mask,
                ]).cropped(to: ext)
            }
        }

        // Back to the sensor buffer orientation (WebRTC applies its rotation).
        var back = composed.oriented(CallFx.inverse(ori))
        back = back.transformed(by: CGAffineTransform(translationX: -back.extent.origin.x, y: -back.extent.origin.y))

        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let fmt = CVPixelBufferGetPixelFormatType(pb)
        guard let out = dequeueBuffer(width: w, height: h, format: fmt) else { return nil }
        CVBufferPropagateAttachments(pb, out)
        // Synchronous render: the buffer must be complete before WebRTC
        // hands it to the encoder / local renderer.
        let dest = CIRenderDestination(pixelBuffer: out)
        do {
            let task = try ciContext.startTask(toRender: back.cropped(to: CGRect(x: 0, y: 0, width: w, height: h)), to: dest)
            _ = try task.waitUntilCompleted()
        } catch {
            return nil
        }
        return out
    }

    // MARK: Segmentation

    private func personMask(_ upright: CIImage, extent ext: CGRect) -> CIImage? {
        let reuse = segEvery > 1 && (frameIndex % UInt64(segEvery)) != 0
        if reuse, let m = lastMask, lastMaskExtent == ext { return m }
        let req: VNGeneratePersonSegmentationRequest
        if let r = segRequest {
            req = r
        } else {
            let r = VNGeneratePersonSegmentationRequest()
            r.qualityLevel = segQualityFast ? .fast : .balanced
            r.outputPixelFormat = kCVPixelFormatType_OneComponent8
            segRequest = r
            req = r
        }
        let handler = VNImageRequestHandler(ciImage: upright, options: [.ciContext: ciContext])
        do {
            try handler.perform([req])
        } catch {
            return lastMaskExtent == ext ? lastMask : nil
        }
        guard let obs = req.results?.first else { return lastMaskExtent == ext ? lastMask : nil }
        let maskPB = obs.pixelBuffer
        var m = CIImage(cvPixelBuffer: maskPB)
        let mExt = m.extent
        guard mExt.width > 0, mExt.height > 0 else { return nil }
        m = m.transformed(by: CGAffineTransform(scaleX: ext.width / mExt.width, y: ext.height / mExt.height))
        // Soft edge (hair / shoulders) without a halo.
        m = m.clampedToExtent().applyingGaussianBlur(sigma: 1.6).cropped(to: ext)
        lastMask = m
        lastMaskExtent = ext
        lastMaskBuffer = maskPB // keep the backing buffer alive for reuse frames
        return m
    }

    // MARK: Backgrounds

    private func blurred(_ img: CIImage, extent ext: CGRect, sigma: Double) -> CIImage {
        // Blur at ¼ res (cheap, same look), then scale back.
        let k: CGFloat = 0.25
        let small = img.transformed(by: CGAffineTransform(scaleX: k, y: k))
        let b = small.clampedToExtent().applyingGaussianBlur(sigma: sigma * Double(k))
            .cropped(to: small.extent)
            .transformed(by: CGAffineTransform(scaleX: 1 / k, y: 1 / k))
        return b.clampedToExtent().cropped(to: ext)
    }

    private func wallpaperImage(index: Int, extent ext: CGRect) -> CIImage? {
        let key = "\(index)@\(Int(ext.width))x\(Int(ext.height))"
        if let c = wallpaperCache[key] { return c }
        guard let cg = CallFxWallpapers.render(index: index, size: ext.size) else { return nil }
        let ci = CIImage(cgImage: cg)
        if wallpaperCache.count > 6 { wallpaperCache.removeAll() }
        wallpaperCache[key] = ci
        return ci
    }

    private func customImage(extent ext: CGRect, version: Int) -> CIImage? {
        let key = "\(version)@\(Int(ext.width))x\(Int(ext.height))"
        if let c = customCache, c.key == key { return c.image }
        if customSource == nil || customSourceVersion != version {
            customSourceVersion = version
            customSource = nil
            if let ui = UIImage(contentsOfFile: CallFx.customFileURL.path) {
                if let cg = ui.cgImage {
                    customSource = CIImage(cgImage: cg).oriented(CallFx.cgOrientation(ui.imageOrientation))
                } else if let ci = ui.ciImage {
                    customSource = ci
                }
            }
        }
        guard var s = customSource else { return nil }
        s = s.transformed(by: CGAffineTransform(translationX: -s.extent.origin.x, y: -s.extent.origin.y))
        // Aspect-fill + center.
        let sc = max(ext.width / s.extent.width, ext.height / s.extent.height)
        s = s.transformed(by: CGAffineTransform(scaleX: sc, y: sc))
        let dx = (ext.width - s.extent.width) / 2, dy = (ext.height - s.extent.height) / 2
        s = s.transformed(by: CGAffineTransform(translationX: dx, y: dy)).cropped(to: ext)
        customCache = (key, s)
        return s
    }

    // MARK: Light filters

    private func applyRetouch(_ img: CIImage, extent ext: CGRect) -> CIImage {
        // Soft-focus "beauty" pass: 30 % of a light blur over the frame (skin
        // smoothing without plastic look) + gentle shadow lift + warmth.
        let soft = img.clampedToExtent().applyingGaussianBlur(sigma: 2.4).cropped(to: ext)
            .applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0.30)])
        var out = soft.composited(over: img).cropped(to: ext)
        out = out.applyingFilter("CIHighlightShadowAdjust", parameters: [
            "inputShadowAmount": 0.35, "inputHighlightAmount": 0.95,
        ])
        out = out.applyingFilter("CIColorControls", parameters: [
            kCIInputBrightnessKey: 0.015, kCIInputContrastKey: 1.02, kCIInputSaturationKey: 1.05,
        ])
        out = out.applyingFilter("CITemperatureAndTint", parameters: [
            "inputNeutral": CIVector(x: 6500, y: 0), "inputTargetNeutral": CIVector(x: 6900, y: 0),
        ])
        return out.cropped(to: ext)
    }

    private func applyLowLight(_ img: CIImage, extent ext: CGRect) -> CIImage {
        var out = img.applyingFilter("CIHighlightShadowAdjust", parameters: [
            "inputShadowAmount": 0.9, "inputHighlightAmount": 1.0,
        ])
        out = out.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: 0.45])
        out = out.applyingFilter("CINoiseReduction", parameters: [
            "inputNoiseLevel": 0.02, "inputSharpness": 0.45,
        ])
        out = out.applyingFilter("CIColorControls", parameters: [
            kCIInputBrightnessKey: 0.0, kCIInputContrastKey: 1.04, kCIInputSaturationKey: 1.08,
        ])
        return out.cropped(to: ext)
    }

    // MARK: Buffers

    private func dequeueBuffer(width w: Int, height h: Int, format fmt: OSType) -> CVPixelBuffer? {
        if pool == nil || poolW != w || poolH != h || poolFmt != fmt {
            pool = nil
            fmtDesc = nil
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: fmt,
                kCVPixelBufferWidthKey as String: w,
                kCVPixelBufferHeightKey as String: h,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            var p: CVPixelBufferPool?
            let poolAttrs: [String: Any] = [kCVPixelBufferPoolMinimumBufferCountKey as String: 3]
            guard CVPixelBufferPoolCreate(kCFAllocatorDefault, poolAttrs as CFDictionary, attrs as CFDictionary, &p) == kCVReturnSuccess,
                  let made = p else { return nil }
            pool = made
            poolW = w; poolH = h; poolFmt = fmt
        }
        guard let p = pool else { return nil }
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, p, &out) == kCVReturnSuccess else { return nil }
        return out
    }

    private static func makeSampleBuffer(from pb: CVPixelBuffer, like sb: CMSampleBuffer,
                                         cachedDesc: inout CMVideoFormatDescription?) -> CMSampleBuffer? {
        if let d = cachedDesc, !CMVideoFormatDescriptionMatchesImageBuffer(d, imageBuffer: pb) {
            cachedDesc = nil
        }
        if cachedDesc == nil {
            var d: CMVideoFormatDescription?
            guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb,
                                                               formatDescriptionOut: &d) == noErr else { return nil }
            cachedDesc = d
        }
        guard let desc = cachedDesc else { return nil }
        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sb),
                                        presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sb),
                                        decodeTimeStamp: CMSampleBufferGetDecodeTimeStamp(sb))
        var out: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb,
                                                       formatDescription: desc, sampleTiming: &timing,
                                                       sampleBufferOut: &out) == noErr,
              let made = out else { return nil }
        // Keep the EXIF / camera attachments WebRTC reads
        // (AVCaptureSession devicePositionForSampleBuffer → front/back).
        CMPropagateAttachments(sb, destination: made)
        return made
    }

    // MARK: Orientation helpers

    /// Same mapping as LKRTCCameraVideoCapturer (m125) → RTCVideoRotation,
    /// expressed as the CGImagePropertyOrientation that makes the buffer upright.
    static func uprightOrientation(interface o: UIInterfaceOrientation, front: Bool) -> CGImagePropertyOrientation {
        switch o {
        case .portrait: return .right                       // 90
        case .portraitUpsideDown: return .left              // 270
        case .landscapeLeft: return front ? .up : .down     // 0 : 180
        case .landscapeRight: return front ? .down : .up    // 180 : 0
        default: return .right
        }
    }

    static func inverse(_ o: CGImagePropertyOrientation) -> CGImagePropertyOrientation {
        switch o {
        case .right: return .left
        case .left: return .right
        default: return o // .up / .down are self-inverse (no mirrored cases used)
        }
    }

    static func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch o {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }

    static func isFrontCamera(sampleBuffer: CMSampleBuffer, connection: AVCaptureConnection) -> Bool {
        if let input = connection.inputPorts.first?.input as? AVCaptureDeviceInput {
            return input.device.position == .front
        }
        return true
    }
}

// MARK: - Capture tap

/// Sits between AVCaptureVideoDataOutput and the WebRTC camera capturer.
/// Runs on the output's own serial queue (WebRTC frameQueue).
final class CallFxCaptureTap: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private weak var original: AVCaptureVideoDataOutputSampleBufferDelegate?

    init(original: AVCaptureVideoDataOutputSampleBufferDelegate) {
        self.original = original
        super.init()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let orig = original else { return }
        switch CallFx.shared.handle(sampleBuffer: sampleBuffer, connection: connection) {
        case .passThrough:
            orig.captureOutput?(output, didOutput: sampleBuffer, from: connection)
        case .drop:
            return
        case .replace(let sb):
            orig.captureOutput?(output, didOutput: sb, from: connection)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        original?.captureOutput?(output, didDrop: sampleBuffer, from: connection)
    }
}

// MARK: - Built-in backgrounds (drawn on device, monochrome — no assets)

enum CallFxWallpapers {
    static let count = 8

    /// Deterministic LCG (same constants as the Android generator).
    private struct Rng {
        var s: UInt32
        mutating func next() -> CGFloat {
            s = s &* 1664525 &+ 1013904223
            return CGFloat(s >> 8) / CGFloat(1 << 24)
        }
    }

    static func render(index: Int, size: CGSize) -> CGImage? {
        let w = max(1, Int(size.width.rounded())), h = max(1, Int(size.height.rounded()))
        let cs = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // Top-left origin like UIKit / Android Canvas so both platforms match.
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        draw(index: index, ctx: ctx, w: CGFloat(w), h: CGFloat(h))
        return ctx.makeImage()
    }

    static func thumbnail(index: Int, side: CGFloat) -> UIImage? {
        let px = side * UIScreen.main.scale
        guard let cg = render(index: index, size: CGSize(width: px, height: px)) else { return nil }
        return UIImage(cgImage: cg, scale: UIScreen.main.scale, orientation: .up)
    }

    private static func gray(_ v: CGFloat, _ a: CGFloat = 1) -> CGColor {
        CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [v, v, v, a])!
    }

    private static func linear(_ ctx: CGContext, _ c0: CGFloat, _ c1: CGFloat, from p0: CGPoint, to p1: CGPoint) {
        let cs = CGColorSpaceCreateDeviceRGB()
        if let g = CGGradient(colorsSpace: cs, colors: [gray(c0), gray(c1)] as CFArray, locations: [0, 1]) {
            ctx.drawLinearGradient(g, start: p0, end: p1, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
    }

    private static func radial(_ ctx: CGContext, _ c0: CGFloat, _ c1: CGFloat, center: CGPoint, radius: CGFloat) {
        let cs = CGColorSpaceCreateDeviceRGB()
        if let g = CGGradient(colorsSpace: cs, colors: [gray(c0), gray(c1)] as CFArray, locations: [0, 1]) {
            ctx.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius,
                                   options: [.drawsAfterEndLocation])
        }
    }

    private static func draw(index: Int, ctx: CGContext, w: CGFloat, h: CGFloat) {
        let mn = min(w, h), mx = max(w, h)
        switch index {
        case 0: // Estúdio — soft spotlight
            radial(ctx, 0.42, 0.11, center: CGPoint(x: w * 0.5, y: h * 0.42), radius: mx * 0.75)
        case 1: // Claro — bright paper
            linear(ctx, 0.93, 0.76, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h))
            ctx.setBlendMode(.screen)
            radial(ctx, 0.25, 0.0, center: CGPoint(x: w * 0.3, y: h * 0.25), radius: mx * 0.5)
            ctx.setBlendMode(.normal)
        case 2: // Grafite
            linear(ctx, 0.23, 0.07, from: CGPoint(x: 0, y: 0), to: CGPoint(x: w, y: h))
        case 3: // Bokeh
            linear(ctx, 0.14, 0.06, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h))
            var r = Rng(s: 7)
            for _ in 0..<22 {
                let cx = r.next() * w, cy = r.next() * h
                let rad = mn * (0.04 + r.next() * 0.09)
                let a = 0.05 + r.next() * 0.13
                ctx.setFillColor(gray(1, a))
                ctx.fillEllipse(in: CGRect(x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2))
            }
        case 4: // Linhas — diagonal pinstripes
            linear(ctx, 0.55, 0.42, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h))
            ctx.setStrokeColor(gray(1, 0.10))
            ctx.setLineWidth(max(1, mn * 0.004))
            let step = max(4, mn * 0.035)
            var x: CGFloat = -h
            while x < w {
                ctx.move(to: CGPoint(x: x, y: h))
                ctx.addLine(to: CGPoint(x: x + h, y: 0))
                x += step
            }
            ctx.strokePath()
        case 5: // Arcos — concentric arcs, light
            linear(ctx, 0.86, 0.80, from: CGPoint(x: 0, y: 0), to: CGPoint(x: w, y: h))
            ctx.setStrokeColor(gray(0, 0.07))
            ctx.setLineWidth(max(1, mn * 0.006))
            let step = max(6, mx * 0.06)
            var rad = step
            while rad < mx * 1.6 {
                ctx.addEllipse(in: CGRect(x: -rad, y: h - rad, width: rad * 2, height: rad * 2))
                rad += step
            }
            ctx.strokePath()
        case 6: // Concreto — speckled mid gray
            linear(ctx, 0.62, 0.55, from: CGPoint(x: 0, y: 0), to: CGPoint(x: w, y: h))
            var r = Rng(s: 11)
            for _ in 0..<1400 {
                let cx = r.next() * w, cy = r.next() * h
                let rad = mx * (0.002 + r.next() * 0.008)
                let v = r.next()
                ctx.setFillColor(gray(v, 0.06))
                ctx.fillEllipse(in: CGRect(x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2))
            }
        default: // 7 Janela — slanted soft light bars
            linear(ctx, 0.20, 0.12, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 0, y: h))
            ctx.setFillColor(gray(1, 0.07))
            let bw = w * 0.09
            for i in 0..<5 {
                let x0 = w * (0.08 + CGFloat(i) * 0.19)
                ctx.move(to: CGPoint(x: x0, y: 0))
                ctx.addLine(to: CGPoint(x: x0 + bw, y: 0))
                ctx.addLine(to: CGPoint(x: x0 + bw + w * 0.25, y: h))
                ctx.addLine(to: CGPoint(x: x0 + w * 0.25, y: h))
                ctx.closePath()
            }
            ctx.fillPath()
        }
    }
}

// MARK: - Effects panel (UIKit; used by the 1:1 and the group screens)

final class CallFxPanel: UIView, PHPickerViewControllerDelegate {
    private weak var hostVC: UIViewController?
    private let cameraOn: () -> Bool
    private let onClosed: () -> Void
    private let card = UIView()
    private let infoLabel = UILabel()
    private var bgItems: [(CallFxBackground, UIButton)] = []
    private var lightItems: [(CallFxLight, UIButton)] = []
    private var observers: [NSObjectProtocol] = []
    private var closing = false

    /// Presents the panel over `vc.view`. `cameraOn` = local camera publishing.
    @discardableResult
    static func present(in vc: UIViewController, cameraOn: @escaping () -> Bool, onClosed: @escaping () -> Void = {}) -> CallFxPanel {
        let p = CallFxPanel(host: vc, cameraOn: cameraOn, onClosed: onClosed)
        p.translatesAutoresizingMaskIntoConstraints = false
        vc.view.addSubview(p)
        NSLayoutConstraint.activate([
            p.topAnchor.constraint(equalTo: vc.view.topAnchor),
            p.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
            p.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
            p.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
        ])
        vc.view.layoutIfNeeded()
        p.animateIn()
        return p
    }

    private init(host: UIViewController, cameraOn: @escaping () -> Bool, onClosed: @escaping () -> Void) {
        self.hostVC = host
        self.cameraOn = cameraOn
        self.onClosed = onClosed
        super.init(frame: .zero)
        buildUI()
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: CallFx.pauseChangedNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshInfo()
        })
        observers.append(nc.addObserver(forName: CallFx.configChangedNotification, object: nil, queue: .main) { [weak self] _ in
            self?.refreshSelection()
        })
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    private func buildUI() {
        backgroundColor = UIColor.black.withAlphaComponent(0.001) // catches taps, keeps PiP visible
        let tap = UITapGestureRecognizer(target: self, action: #selector(backdropTapped(_:)))
        tap.cancelsTouchesInView = false
        addGestureRecognizer(tap)

        card.translatesAutoresizingMaskIntoConstraints = false
        card.backgroundColor = UIColor(white: 0.07, alpha: 0.96)
        card.layer.cornerRadius = 24
        card.layer.borderWidth = 0.5
        card.layer.borderColor = UIColor.white.withAlphaComponent(0.08).cgColor
        card.alpha = 0
        addSubview(card)

        let grabber = UIView()
        grabber.translatesAutoresizingMaskIntoConstraints = false
        grabber.backgroundColor = UIColor.white.withAlphaComponent(0.25)
        grabber.layer.cornerRadius = 2.5
        card.addSubview(grabber)

        let header = UILabel()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.text = CallFxStrings.s("title")
        header.textColor = .white
        header.font = .systemFont(ofSize: 18, weight: .semibold)
        header.textAlignment = .center
        card.addSubview(header)

        infoLabel.translatesAutoresizingMaskIntoConstraints = false
        infoLabel.textColor = UIColor.white.withAlphaComponent(0.7)
        infoLabel.font = .systemFont(ofSize: 13, weight: .regular)
        infoLabel.textAlignment = .center
        infoLabel.numberOfLines = 2
        card.addSubview(infoLabel)

        // Background row
        var bgButtons: [UIView] = []
        var bgOptions: [(CallFxBackground, String, UIImage?)] = [
            (.none, CallFxStrings.s("none"), self.symbol("nosign")),
            (.blurLight, CallFxStrings.s("blurLight"), self.symbol("drop")),
            (.blurStrong, CallFxStrings.s("blurStrong"), self.symbol("drop.fill")),
        ]
        for i in 0..<CallFxWallpapers.count {
            bgOptions.append((.wallpaper(i), CallFxStrings.s("bgN", ["n": "\(i + 1)"]), CallFxWallpapers.thumbnail(index: i, side: 60)))
        }
        for (bg, title, img) in bgOptions {
            let isThumb: Bool
            if case .wallpaper = bg { isThumb = true } else { isThumb = false }
            let (wrap, btn) = makeItem(title: isThumb ? "" : title, a11y: title, image: img, fillsImage: isThumb)
            btn.addTarget(self, action: #selector(bgTapped(_:)), for: .touchUpInside)
            bgItems.append((bg, btn))
            btn.tag = bgItems.count - 1
            bgButtons.append(wrap)
        }
        // Gallery
        do {
            let thumb = CallFx.shared.hasCustomImage ? UIImage(contentsOfFile: CallFx.customFileURL.path) : nil
            let (wrap, btn) = makeItem(title: CallFxStrings.s("gallery"), a11y: CallFxStrings.s("gallery"),
                                       image: thumb ?? symbol("photo.on.rectangle"), fillsImage: thumb != nil)
            btn.addTarget(self, action: #selector(galleryTapped(_:)), for: .touchUpInside)
            bgItems.append((.custom, btn))
            btn.tag = 1000
            bgButtons.append(wrap)
        }
        let bgRow = makeRow(title: CallFxStrings.s("background"), items: bgButtons)

        // Light row
        var lightButtons: [UIView] = []
        let lightOptions: [(CallFxLight, String, String)] = [
            (.none, CallFxStrings.s("none"), "nosign"),
            (.retouch, CallFxStrings.s("retouch"), "wand.and.stars"),
            (.lowLight, CallFxStrings.s("lowLight"), "sun.max"),
        ]
        for (l, title, sym) in lightOptions {
            let (wrap, btn) = makeItem(title: title, a11y: title, image: symbol(sym), fillsImage: false)
            btn.addTarget(self, action: #selector(lightTapped(_:)), for: .touchUpInside)
            lightItems.append((l, btn))
            btn.tag = lightItems.count - 1
            lightButtons.append(wrap)
        }
        let lightRow = makeRow(title: CallFxStrings.s("light"), items: lightButtons)

        let stack = UIStackView(arrangedSubviews: [bgRow, lightRow])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 14
        card.addSubview(stack)

        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor, constant: 8),
            card.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -8),
            card.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -8),

            grabber.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
            grabber.centerXAnchor.constraint(equalTo: card.centerXAnchor),
            grabber.widthAnchor.constraint(equalToConstant: 40),
            grabber.heightAnchor.constraint(equalToConstant: 5),

            header.topAnchor.constraint(equalTo: grabber.bottomAnchor, constant: 10),
            header.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            header.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),

            infoLabel.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 4),
            infoLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            infoLabel.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),

            stack.topAnchor.constraint(equalTo: infoLabel.bottomAnchor, constant: 8),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
        ])
        refreshSelection()
        refreshInfo()
    }

    private func symbol(_ name: String) -> UIImage? {
        UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))
    }

    private func makeRow(title: String, items: [UIView]) -> UIView {
        let col = UIView()
        col.translatesAutoresizingMaskIntoConstraints = false
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = title
        label.textColor = UIColor.white.withAlphaComponent(0.6)
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        col.addSubview(label)

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        col.addSubview(scroll)

        let row = UIStackView(arrangedSubviews: items)
        row.translatesAutoresizingMaskIntoConstraints = false
        row.axis = .horizontal
        row.spacing = 12
        row.alignment = .top
        scroll.addSubview(row)

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: col.topAnchor),
            label.leadingAnchor.constraint(equalTo: col.leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(lessThanOrEqualTo: col.trailingAnchor, constant: -16),

            scroll.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: col.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: col.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: col.bottomAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 92),

            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -16),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
        return col
    }

    /// 60×60 rounded tile + caption under it.
    private func makeItem(title: String, a11y: String, image: UIImage?, fillsImage: Bool) -> (UIView, UIButton) {
        let wrap = UIView()
        wrap.translatesAutoresizingMaskIntoConstraints = false

        let btn = UIButton(type: .custom)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        btn.layer.cornerRadius = 16
        btn.clipsToBounds = true
        btn.tintColor = .white
        btn.accessibilityLabel = a11y
        if fillsImage {
            btn.setImage(image, for: .normal)
            btn.imageView?.contentMode = .scaleAspectFill
            btn.contentHorizontalAlignment = .fill
            btn.contentVerticalAlignment = .fill
        } else {
            btn.setImage(image, for: .normal)
            btn.imageView?.contentMode = .center
        }
        wrap.addSubview(btn)

        let cap = UILabel()
        cap.translatesAutoresizingMaskIntoConstraints = false
        cap.text = title
        cap.textColor = UIColor.white.withAlphaComponent(0.85)
        cap.font = .systemFont(ofSize: 11, weight: .medium)
        cap.textAlignment = .center
        cap.numberOfLines = 2
        cap.adjustsFontSizeToFitWidth = true
        cap.minimumScaleFactor = 0.8
        cap.isUserInteractionEnabled = false
        wrap.addSubview(cap)

        NSLayoutConstraint.activate([
            wrap.widthAnchor.constraint(equalToConstant: 68),
            btn.topAnchor.constraint(equalTo: wrap.topAnchor, constant: 2),
            btn.centerXAnchor.constraint(equalTo: wrap.centerXAnchor),
            btn.widthAnchor.constraint(equalToConstant: 60),
            btn.heightAnchor.constraint(equalToConstant: 60),
            cap.topAnchor.constraint(equalTo: btn.bottomAnchor, constant: 4),
            cap.leadingAnchor.constraint(equalTo: wrap.leadingAnchor),
            cap.trailingAnchor.constraint(equalTo: wrap.trailingAnchor),
            cap.bottomAnchor.constraint(lessThanOrEqualTo: wrap.bottomAnchor),
        ])
        return (wrap, btn)
    }

    private func refreshSelection() {
        let bg = CallFx.shared.background
        for (b, btn) in bgItems { styleSelected(btn, b == bg) }
        let l = CallFx.shared.light
        for (x, btn) in lightItems { styleSelected(btn, x == l) }
    }

    private func styleSelected(_ btn: UIButton, _ on: Bool) {
        btn.layer.borderWidth = on ? 2.5 : 0
        btn.layer.borderColor = UIColor.white.cgColor
        btn.isSelected = on
        btn.accessibilityTraits = on ? [.button, .selected] : [.button]
    }

    private func refreshInfo() {
        if let t = CallFx.pauseToastText(CallFx.shared.pauseReason) {
            infoLabel.text = t
        } else if !cameraOn() {
            infoLabel.text = CallFxStrings.s("camOff")
        } else {
            infoLabel.text = nil
        }
    }

    // MARK: Actions

    @objc private func bgTapped(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < bgItems.count else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        CallFx.shared.setBackground(bgItems[sender.tag].0)
        refreshSelection()
    }

    @objc private func lightTapped(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < lightItems.count else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        CallFx.shared.setLight(lightItems[sender.tag].0)
        refreshSelection()
    }

    @objc private func galleryTapped(_ sender: UIButton) {
        guard let host = hostVC else { return }
        var cfg = PHPickerConfiguration()
        cfg.filter = .images
        cfg.selectionLimit = 1
        let picker = PHPickerViewController(configuration: cfg)
        picker.delegate = self
        host.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else { return }
        provider.loadObject(ofClass: UIImage.self) { [weak self] obj, _ in
            guard let img = obj as? UIImage else { return }
            let ok = CallFx.shared.saveCustomImage(img)
            DispatchQueue.main.async {
                guard let self = self, ok else { return }
                if let idx = self.bgItems.firstIndex(where: { $0.0 == .custom }) {
                    let btn = self.bgItems[idx].1
                    btn.setImage(UIImage(contentsOfFile: CallFx.customFileURL.path), for: .normal)
                    btn.imageView?.contentMode = .scaleAspectFill
                    btn.contentHorizontalAlignment = .fill
                    btn.contentVerticalAlignment = .fill
                }
                self.refreshSelection()
            }
        }
    }

    @objc private func backdropTapped(_ g: UITapGestureRecognizer) {
        let p = g.location(in: self)
        if card.frame.contains(p) { return }
        close()
    }

    private func animateIn() {
        card.transform = CGAffineTransform(translationX: 0, y: 40)
        UIView.animate(withDuration: 0.28, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0.6,
                       options: [.allowUserInteraction, .curveEaseOut], animations: {
            self.card.alpha = 1
            self.card.transform = .identity
        })
    }

    func close() {
        guard !closing else { return }
        closing = true
        UIView.animate(withDuration: 0.18, delay: 0, options: [.curveEaseIn], animations: {
            self.card.alpha = 0
            self.card.transform = CGAffineTransform(translationX: 0, y: 40)
        }, completion: { _ in
            self.removeFromSuperview()
            self.onClosed()
        })
    }
}
