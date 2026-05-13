import ExpoModulesCore
import AVFoundation
import UIKit

// -----------------------------------------------------------------------------
// ExpoRtmpPublisherModule (SKELETON)
//
// Native RTMP publisher for Expo. The real implementation will use HaishinKit
// (https://github.com/HaishinKit/HaishinKit.swift) to capture camera + mic and
// push H.264/AAC over RTMPS to Cloudflare Stream Live ingest:
//
//   rtmps://live.cloudflare.com:443/live/{streamKey}
//
// This file is intentionally stubbed — every native method resolves immediately
// without doing real work. Replace the TODO bodies with HaishinKit calls.
//
// Reference flow once wired up:
//   1. Create an `RTMPStream` attached to an `RTMPConnection`.
//   2. `stream.attachCamera(AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back))`
//   3. `stream.attachAudio(AVCaptureDevice.default(for: .audio))`
//   4. Configure video/audio settings (bitrate, resolution, fps, profile=.high, level=.h264_4_2).
//   5. `connection.connect(opts.url)` → on `.connect.success`, call `stream.publish(streamKey)`.
//   6. Forward HaishinKit's RTMPStream events to JS via the Module's event sink.
//
// Frame previews can be attached to a SwiftUI / UIKit view via `MTHKView` —
// for the v1 we ship a "no preview" version (broadcast-only) so we don't have
// to wire view managers into the Expo module system.
// -----------------------------------------------------------------------------

public class ExpoRtmpPublisherModule: Module {

    // MARK: - State

    private enum Status: String {
        case idle, connecting, publishing, reconnecting, stopped, error
    }

    private var status: Status = .idle
    private var lastStats: [String: Any]? = nil
    private var currentCamera: String = "back"

    // TODO: hold HaishinKit references once integrated.
    // private var rtmpConnection: RTMPConnection?
    // private var rtmpStream: RTMPStream?

    public func definition() -> ModuleDefinition {
        Name("ExpoRtmpPublisher")

        Events(
            "onStatusChange",
            "onStats",
            "onError",
            "onConnected",
            "onDisconnected"
        )

        // ---------------------------------------------------------------------
        // start(opts)
        // ---------------------------------------------------------------------
        AsyncFunction("start") { (opts: [String: Any], promise: Promise) in
            guard let url = opts["url"] as? String,
                  let streamKey = opts["streamKey"] as? String,
                  !url.isEmpty, !streamKey.isEmpty else {
                promise.reject("ERR_INVALID_OPTS", "url and streamKey are required")
                return
            }

            let _videoBitrate = opts["videoBitrate"] as? Int ?? 2_500_000
            let _audioBitrate = opts["audioBitrate"] as? Int ?? 128_000
            let _width = opts["width"] as? Int ?? 1280
            let _height = opts["height"] as? Int ?? 720
            let _fps = opts["fps"] as? Int ?? 30
            let camera = opts["camera"] as? String ?? "back"
            self.currentCamera = camera

            // TODO: real implementation
            //
            //   import HaishinKit
            //   import VideoToolbox
            //
            //   self.rtmpConnection = RTMPConnection()
            //   self.rtmpStream = RTMPStream(connection: self.rtmpConnection!)
            //   self.rtmpStream?.videoSettings = .init(
            //       videoSize: .init(width: _width, height: _height),
            //       bitRate: _videoBitrate,
            //       profileLevel: kVTProfileLevel_H264_High_AutoLevel as String,
            //       maxKeyFrameIntervalDuration: 2
            //   )
            //   self.rtmpStream?.audioSettings = .init(bitRate: _audioBitrate)
            //   self.rtmpStream?.frameRate = Float64(_fps)
            //
            //   let position: AVCaptureDevice.Position = camera == "front" ? .front : .back
            //   self.rtmpStream?.attachCamera(AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position))
            //   self.rtmpStream?.attachAudio(AVCaptureDevice.default(for: .audio))
            //
            //   NotificationCenter.default.addObserver(self, selector: #selector(self.onStatusEvent),
            //       name: .rtmpStatusEvent, object: self.rtmpConnection)
            //   self.rtmpConnection?.connect(url)
            //   // On .connect.success → self.rtmpStream?.publish(streamKey)
            //
            // For now the stub just flips state and resolves.

            self.setStatus(.connecting)

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.setStatus(.publishing)
                self.sendEvent("onConnected", ["url": url])
                promise.resolve(nil)
            }
        }

        // ---------------------------------------------------------------------
        // stop()
        // ---------------------------------------------------------------------
        AsyncFunction("stop") { (promise: Promise) in
            // TODO:
            //   self.rtmpStream?.close()
            //   self.rtmpStream?.dispose()
            //   self.rtmpConnection?.close()
            //   self.rtmpStream = nil
            //   self.rtmpConnection = nil
            self.setStatus(.stopped)
            self.sendEvent("onDisconnected", ["reason": "user_stop"])
            promise.resolve(nil)
        }

        // ---------------------------------------------------------------------
        // switchCamera()
        // ---------------------------------------------------------------------
        AsyncFunction("switchCamera") { (promise: Promise) in
            let next = self.currentCamera == "front" ? "back" : "front"
            self.currentCamera = next

            // TODO:
            //   let position: AVCaptureDevice.Position = next == "front" ? .front : .back
            //   self.rtmpStream?.attachCamera(AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position))

            promise.resolve(nil)
        }

        // ---------------------------------------------------------------------
        // setMuted(muted)
        // ---------------------------------------------------------------------
        AsyncFunction("setMuted") { (muted: Bool, promise: Promise) in
            // TODO:
            //   self.rtmpStream?.hasAudio = !muted
            promise.resolve(nil)
        }

        // ---------------------------------------------------------------------
        // setVideoEnabled(enabled)
        // ---------------------------------------------------------------------
        AsyncFunction("setVideoEnabled") { (enabled: Bool, promise: Promise) in
            // TODO:
            //   self.rtmpStream?.hasVideo = enabled
            promise.resolve(nil)
        }

        // ---------------------------------------------------------------------
        // getStatus()
        // ---------------------------------------------------------------------
        Function("getStatus") { () -> String in
            return self.status.rawValue
        }

        // ---------------------------------------------------------------------
        // getStats()
        // ---------------------------------------------------------------------
        Function("getStats") { () -> [String: Any]? in
            return self.lastStats
        }
    }

    // MARK: - Helpers

    private func setStatus(_ next: Status, reason: String? = nil) {
        self.status = next
        var payload: [String: Any] = ["status": next.rawValue]
        if let reason = reason { payload["reason"] = reason }
        self.sendEvent("onStatusChange", payload)
    }
}
