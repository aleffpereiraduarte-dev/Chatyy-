import Foundation
import AVFoundation

// -----------------------------------------------------------------------------
// AVPoolManager — Stage 2 (2026-05-16)
//
// 3-instance AVPlayer pool mirroring ExoPoolManager.kt on Android.
// Reusing AVPlayer instances avoids the ~50ms cost of allocating a new
// audio session + render pipeline on every scroll.
//
// LRU strategy:
//   - Each slot tracks `lastTouched` (CFAbsoluteTime).
//   - On getPlayerForUrl: if a slot's `boundUrl == url`, return it (HIT).
//   - Otherwise pick the slot with the OLDEST `lastTouched` (LRU) and
//     replace its current item.
//
// HLS:
//   - AVURLAsset handles HLS automatically when the URL ends in .m3u8 or
//     content-type is application/vnd.apple.mpegurl. We don't have to do
//     anything special — we still tag it for parity with Android.
//
// Threading: every method serialised on a private queue + dispatched to
// main when touching AVPlayer (KVO requirements). We hold no AVAsset
// loads here — letting AVPlayer drive its own loader keeps the code simple
// and matches IG/WhatsApp's behaviour (no manual preroll).
// -----------------------------------------------------------------------------

@objc public final class AVPoolManager: NSObject {

  @objc public static let shared = AVPoolManager()

  private static let POOL_SIZE = 3

  private final class Slot {
    var player: AVPlayer?
    var boundUrl: String?
    var lastTouched: CFAbsoluteTime = 0
  }

  private let lock = NSLock()
  private var slots: [Slot]

  private override init() {
    slots = (0..<AVPoolManager.POOL_SIZE).map { _ in Slot() }
    super.init()
  }

  // ---------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------

  /**
   Returns an AVPlayer bound to `url`. Reuses an existing slot if hit, else
   evicts the LRU slot. Always called on main thread (Expo prop setters).
   */
  @objc public func getPlayer(forUrlString urlString: String) -> AVPlayer? {
    guard let url = URL(string: urlString) else { return nil }
    lock.lock(); defer { lock.unlock() }
    let now = CFAbsoluteTimeGetCurrent()

    // 1) Hit path.
    if let hit = slots.first(where: { $0.boundUrl == urlString && $0.player != nil }) {
      hit.lastTouched = now
      return hit.player
    }

    // 2) Miss — ensure all slots have a player.
    for slot in slots where slot.player == nil {
      slot.player = makePlayer()
    }

    // Pick LRU.
    guard let victim = slots.min(by: { $0.lastTouched < $1.lastTouched }),
          let player = victim.player else {
      return nil
    }

    bind(player: player, url: url)
    victim.boundUrl = urlString
    victim.lastTouched = now
    return player
  }

  /**
   Fire-and-forget warm-up: bind URL to a free / LRU slot, replace item, but
   leave the player paused. If already bound, just bumps LRU.
   */
  @objc public func prefetch(urlString: String) {
    lock.lock(); defer { lock.unlock() }
    let now = CFAbsoluteTimeGetCurrent()
    if let hit = slots.first(where: { $0.boundUrl == urlString && $0.player != nil }) {
      hit.lastTouched = now
      return
    }
    guard let url = URL(string: urlString) else { return }
    for slot in slots where slot.player == nil {
      slot.player = makePlayer()
    }
    guard let victim = slots.min(by: { $0.lastTouched < $1.lastTouched }),
          let player = victim.player else { return }
    bind(player: player, url: url)
    player.pause()
    victim.boundUrl = urlString
    victim.lastTouched = now
  }

  /** Release all 3 players. Call on Reels feed unmount / memory warning. */
  @objc public func release() {
    lock.lock(); defer { lock.unlock() }
    for slot in slots {
      slot.player?.pause()
      slot.player?.replaceCurrentItem(with: nil)
      slot.player = nil
      slot.boundUrl = nil
      slot.lastTouched = 0
    }
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private func makePlayer() -> AVPlayer {
    let p = AVPlayer()
    // Reels: never auto-pause when the player buffers underrun — keep
    // trying. iOS 13+ default is .pause; we want .none so the indicator
    // logic stays in JS-land.
    p.automaticallyWaitsToMinimizeStalling = true
    p.actionAtItemEnd = .none // we loop manually via NotificationCenter in the view
    p.isMuted = true // pool default; view will override
    return p
  }

  private func bind(player: AVPlayer, url: URL) {
    // AVURLAsset auto-detects HLS via Content-Type or .m3u8 extension.
    let asset = AVURLAsset(url: url, options: [
      "AVURLAssetPreferPreciseDurationAndTimingKey": false
    ])
    let item = AVPlayerItem(asset: asset)
    // 1s preferred buffer — snappy reels.
    item.preferredForwardBufferDuration = 1.0
    player.replaceCurrentItem(with: item)
  }

  /// HLS detection — matches Android's ExoPoolManager.looksLikeHls.
  @objc public static func looksLikeHls(_ urlString: String) -> Bool {
    let lower = urlString.lowercased()
    let noHash = lower.split(separator: "#").first.map(String.init) ?? lower
    let path = noHash.split(separator: "?").first.map(String.init) ?? noHash
    if path.hasSuffix(".m3u8") { return true }
    if noHash.contains("type=hls") { return true }
    return false
  }
}
