import Foundation
import MediaPlayer
import UIKit

/// [2026-10-09 media-native] Lock-screen / Control Center controls for the
/// voice-note player (WhatsApp parity).
///
/// Fed by ExpoNativeAudioModule: every `onVoiceStatus` body the
/// VoiceNotePlayer emits passes through `onStatus(_:)` — so this file needs
/// no hooks inside the player. MPNowPlayingInfoCenter is only rewritten on
/// coarse changes (play/pause, rate, duration, seek, end); iOS extrapolates
/// the elapsed time from the rate between updates, so the 4 Hz ticks are
/// ignored.
///
/// Remote commands (play / pause / toggle / scrub / ±15 s) act on the player
/// directly; the player then emits its normal status → JS state follows
/// (services/voiceNotePlayer.js `_onEngineStatus`).
///
/// Background: the app has UIBackgroundModes=audio and the player uses
/// `.playback` on the loudspeaker, so a note keeps playing when the user
/// leaves the chat or locks the phone.
///
/// Main queue only (module functions run `.runOnQueue(.main)`, status is
/// emitted on main).
final class VoiceNowPlaying {
  private weak var player: VoiceNotePlayer?
  private var title: String = ""
  private var subtitle: String = ""
  private var artwork: MPMediaItemArtwork?
  private var artworkUri: String?
  private var commandsInstalled = false
  private var commandTargets: [(MPRemoteCommand, Any)] = []
  private var active = false
  private var enabled = true

  // Last values written to the info center (change detection).
  private var lastPlaying: Bool?
  private var lastRate: Double = -1
  private var lastDurationMs: Double = -1
  private var lastToken: Int = -1

  init(player: VoiceNotePlayer) {
    self.player = player
  }

  // MARK: - Metadata from JS

  func setMetadata(_ meta: [String: Any]) {
    if let e = meta["enabled"] as? Bool { enabled = e }
    if let t = meta["title"] as? String { title = t }
    if let s = meta["subtitle"] as? String { subtitle = s }
    let art = meta["artworkUri"] as? String
    if art != artworkUri {
      artworkUri = art
      artwork = nil
      if let a = art, !a.isEmpty { loadArtwork(a) }
    }
    if !enabled {
      clear()
      return
    }
    if active { pushInfo(force: true) }
  }

  // MARK: - Status feed (from the module's emit wrapper)

  func onStatus(_ body: [String: Any]) {
    guard enabled else { return }
    let playing = (body["playing"] as? Bool) ?? false
    let rate = (body["rate"] as? Double) ?? 1
    let dur = (body["durationMs"] as? Double) ?? 0
    let token = (body["token"] as? Int) ?? 0
    if body["error"] != nil && !playing {
      clear()
      return
    }
    if !active {
      // Only start showing once something actually plays.
      guard playing else { return }
      active = true
      installCommands()
    }
    let coarse = body["seeked"] != nil || body["ended"] != nil || body["reason"] != nil
    if coarse || lastPlaying != playing || abs(lastRate - rate) > 0.001
        || abs(lastDurationMs - dur) > 1 || lastToken != token {
      lastPlaying = playing
      lastRate = rate
      lastDurationMs = dur
      lastToken = token
      write(body: body)
    }
  }

  func clear() {
    guard active || commandsInstalled else { return }
    active = false
    lastPlaying = nil
    lastRate = -1
    lastDurationMs = -1
    lastToken = -1
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    removeCommands()
  }

  // MARK: - Info center

  private func pushInfo(force: Bool) {
    guard let p = player else { return }
    write(body: p.status())
  }

  private func write(body: [String: Any]) {
    let playing = (body["playing"] as? Bool) ?? false
    let rate = (body["rate"] as? Double) ?? 1
    let pos = ((body["positionMs"] as? Double) ?? 0) / 1000.0
    let dur = ((body["durationMs"] as? Double) ?? 0) / 1000.0
    var info: [String: Any] = [:]
    info[MPMediaItemPropertyTitle] = title.isEmpty ? VoiceNowPlaying.appName() : title
    if !subtitle.isEmpty { info[MPMediaItemPropertyArtist] = subtitle }
    if dur > 0 { info[MPMediaItemPropertyPlaybackDuration] = dur }
    info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, pos)
    info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? rate : 0.0
    info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = rate
    info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
    if let art = artwork { info[MPMediaItemPropertyArtwork] = art }
    // (playbackState is macOS-only; iOS derives play/pause from the rate.)
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  // MARK: - Remote commands

  private func installCommands() {
    if commandsInstalled { return }
    commandsInstalled = true
    let cc = MPRemoteCommandCenter.shared()

    func add(_ cmd: MPRemoteCommand, _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
      cmd.isEnabled = true
      let target = cmd.addTarget(handler: handler)
      commandTargets.append((cmd, target))
    }

    add(cc.playCommand) { [weak self] _ in
      guard let p = self?.player else { return .noActionableNowPlayingItem }
      p.resume()
      return .success
    }
    add(cc.pauseCommand) { [weak self] _ in
      guard let p = self?.player else { return .noActionableNowPlayingItem }
      p.pause()
      return .success
    }
    add(cc.togglePlayPauseCommand) { [weak self] _ in
      guard let p = self?.player else { return .noActionableNowPlayingItem }
      let st = p.status()
      if (st["playing"] as? Bool) == true { p.pause() } else { p.resume() }
      return .success
    }
    add(cc.changePlaybackPositionCommand) { [weak self] ev in
      guard let p = self?.player, let e = ev as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      p.seek(ms: e.positionTime * 1000.0)
      return .success
    }
    cc.skipForwardCommand.preferredIntervals = [15]
    cc.skipBackwardCommand.preferredIntervals = [15]
    add(cc.skipForwardCommand) { [weak self] _ in
      guard let p = self?.player else { return .noActionableNowPlayingItem }
      let st = p.status()
      let pos = (st["positionMs"] as? Double) ?? 0
      let dur = (st["durationMs"] as? Double) ?? 0
      let target = pos + 15000
      p.seek(ms: dur > 0 ? min(target, max(0, dur - 250)) : target)
      return .success
    }
    add(cc.skipBackwardCommand) { [weak self] _ in
      guard let p = self?.player else { return .noActionableNowPlayingItem }
      let st = p.status()
      let pos = (st["positionMs"] as? Double) ?? 0
      p.seek(ms: max(0, pos - 15000))
      return .success
    }
  }

  private func removeCommands() {
    guard commandsInstalled else { return }
    commandsInstalled = false
    for (cmd, target) in commandTargets {
      cmd.removeTarget(target)
    }
    commandTargets.removeAll()
  }

  // MARK: - Artwork

  private func loadArtwork(_ uri: String) {
    guard let url = VoiceNotePlayer.makeURL(uri) else { return }
    let wanted = uri
    let apply: (UIImage) -> Void = { [weak self] img in
      DispatchQueue.main.async {
        guard let self = self, self.artworkUri == wanted else { return }
        self.artwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        if self.active { self.pushInfo(force: true) }
      }
    }
    if url.isFileURL {
      DispatchQueue.global(qos: .utility).async {
        if let data = try? Data(contentsOf: url), let img = UIImage(data: data) { apply(img) }
      }
      return
    }
    guard url.scheme == "https" || url.scheme == "http" else { return }
    URLSession.shared.dataTask(with: url) { data, _, _ in
      if let d = data, let img = UIImage(data: d) { apply(img) }
    }.resume()
  }

  private static func appName() -> String {
    let b = Bundle.main
    return (b.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
      ?? (b.object(forInfoDictionaryKey: "CFBundleName") as? String)
      ?? "Chatyy"
  }
}
