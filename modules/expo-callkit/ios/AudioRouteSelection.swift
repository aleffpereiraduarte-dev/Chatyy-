// AudioRouteSelection.swift — [2026-10-09 route-picker] WhatsApp/FaceTime-
// style audio output picker for the 1:1 call screen. When AirPods / a BT
// headset / CarPlay / a wired headset is available, tapping "Alto-falante"
// opens a sheet (iPhone · Alto-falante · <device>) instead of a blind toggle —
// before, with AirPods connected there was no way back to the earpiece.
//
// Pure public API on top of AudioRouter (setSpeaker) + AVAudioSession
// preferred input (HFP/CarPlay/wired output follows the selected input).

import Foundation
import AVFoundation
import UIKit

struct CallAudioRouteOption {
    let id: String        // "receiver" | "speaker" | port UID
    let title: String
    let selected: Bool
}

enum CallNativeStrings {
    private static var lang: String {
        let code = (Locale.preferredLanguages.first ?? "pt").lowercased()
        if code.hasPrefix("en") { return "en" }
        if code.hasPrefix("es") { return "es" }
        return "pt"
    }

    static func routeReceiver() -> String {
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }

    static func routeSpeaker() -> String {
        switch lang {
        case "en": return "Speaker"
        case "es": return "Altavoz"
        default: return "Alto-falante"
        }
    }

    static func routeSheetTitle() -> String {
        switch lang {
        case "en": return "Audio"
        case "es": return "Audio"
        default: return "Áudio"
        }
    }

    static func cancel() -> String {
        switch lang {
        case "en": return "Cancel"
        case "es": return "Cancelar"
        default: return "Cancelar"
        }
    }
}

extension AudioRouter {
    private static let externalInputPorts: [AVAudioSession.Port] = [
        .bluetoothHFP, .bluetoothLE, .carAudio, .headsetMic, .usbAudio,
    ]
    /// Set when we pinned a preferred input; reset at call teardown so the
    /// next call starts with the system default (AirPods win again).
    private static var didPinPreferredInput = false

    /// True when there is something other than receiver/speaker to choose.
    @objc public func hasSelectableExternalRoute() -> Bool {
        let session = AVAudioSession.sharedInstance()
        if (session.availableInputs ?? []).contains(where: { Self.externalInputPorts.contains($0.portType) }) {
            return true
        }
        return session.currentRoute.outputs.contains { port in
            switch port.portType {
            case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .carAudio, .headphones, .usbAudio, .airPlay:
                return true
            default:
                return false
            }
        }
    }

    func selectableRoutes() -> [CallAudioRouteOption] {
        let session = AVAudioSession.sharedInstance()
        let outs = session.currentRoute.outputs.map { $0.portType }
        let currentInputUID = session.currentRoute.inputs.first?.uid
        let onSpeaker = outs.contains(.builtInSpeaker)
        let onReceiver = outs.contains(.builtInReceiver)
        var options: [CallAudioRouteOption] = []
        let hasBuiltInMic = (session.availableInputs ?? []).contains { $0.portType == .builtInMic }
        if hasBuiltInMic && UIDevice.current.userInterfaceIdiom == .phone {
            options.append(CallAudioRouteOption(id: "receiver", title: CallNativeStrings.routeReceiver(), selected: onReceiver))
        }
        options.append(CallAudioRouteOption(id: "speaker", title: CallNativeStrings.routeSpeaker(), selected: onSpeaker))
        for port in session.availableInputs ?? [] where Self.externalInputPorts.contains(port.portType) {
            let selected = !onSpeaker && !onReceiver && port.uid == currentInputUID
            options.append(CallAudioRouteOption(id: port.uid, title: port.portName, selected: selected))
        }
        return options
    }

    /// Apply a choice from selectableRoutes(). Main thread.
    func selectRoute(id: String) {
        let session = AVAudioSession.sharedInstance()
        switch id {
        case "speaker":
            _ = setSpeaker(true)
        case "receiver":
            if let mic = (session.availableInputs ?? []).first(where: { $0.portType == .builtInMic }) {
                do {
                    try session.setPreferredInput(mic)
                    Self.didPinPreferredInput = true
                } catch {
                    print("[AudioRouter] setPreferredInput(builtInMic) failed: \(error)")
                }
            }
            _ = setSpeaker(false)
        default:
            if let port = (session.availableInputs ?? []).first(where: { $0.uid == id }) {
                do {
                    try session.setPreferredInput(port)
                    Self.didPinPreferredInput = true
                } catch {
                    print("[AudioRouter] setPreferredInput(\(port.portName)) failed: \(error)")
                }
            }
            _ = setSpeaker(false)
        }
        print("[AudioRouter] route selected id=\(id) outputs=\(session.currentRoute.outputs.map { $0.portType.rawValue })")
    }

    /// Called from teardown(): drop a pinned preferred input.
    static func resetPreferredInputIfNeeded() {
        guard didPinPreferredInput else { return }
        didPinPreferredInput = false
        do {
            try AVAudioSession.sharedInstance().setPreferredInput(nil)
        } catch {
            print("[AudioRouter] setPreferredInput(nil) failed: \(error)")
        }
    }
}
