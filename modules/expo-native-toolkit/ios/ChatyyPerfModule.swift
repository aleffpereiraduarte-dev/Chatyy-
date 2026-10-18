import ExpoModulesCore
import Foundation
import MetricKit
import os
import QuartzCore
import UIKit

// [2026-10-18 perf-telemetry] Fluidez + saúde nativa (JS: services/nativeTelemetry.js §perf).
//
// Antes só havia o freezeWatch (stall do JS > 2,5 s): nada de quadro perdido, memória
// ou motivo de saída — as mortes "prev_end as=active" em /chat, /chat-conversation e
// /settings-section ficavam sem causa. Este módulo agrega TUDO no nativo e o JS só
// lê lotes prontos:
//
//   • quadros   — CADisplayLink no main run loop (só com o app ativo; para em 2º
//                 plano). Por rota atual (setRoute): n quadros, sl lentos (> 2× o
//                 orçamento do quadro), fz congelados (≥ 700 ms), mx maior quadro (ms),
//                 j excesso total (ms acima do orçamento). Custo por quadro = O(1).
//   • memória   — phys_footprint (task_vm_info) a cada 5 s: pico da janela/sessão,
//                 atual e os_proc_available_memory mínimo; didReceiveMemoryWarning.
//   • janela    — fecha a cada 60 s ou ao ir p/ 2º plano → fila persistida
//                 (UserDefaults, teto 30) + evento "onPerfWindow". O JS lê com
//                 peek() e confirma com ack(seq) só depois do POST — sobrevive à morte.
//   • sessão anterior — registro "vivo" (rota, fg, memória, avisos) gravado a cada
//                 janela/transição; lido no próximo start → prev() (morreu ativo?
//                 em qual rota? com quanta memória? main thread travada?).
//   • MetricKit — MXAppExitMetric (contagens de saída fg/bg por motivo), pico de
//                 memória, histograma de travamentos; MXCrashDiagnostic / Hang /
//                 CPU / disk resumidos (tipo, sinal, motivo, ≤ 6 quadros do topo,
//                 ~1 KB). Nunca a pilha crua.
//
// Nada lança p/ o JS. Kill switch: o JS não chama start() (globalThis.__chatyy_perf_telemetry
// === false) → nenhum display link/timer roda; só o assinante do MetricKit (passivo).

private let kPendingKey = "chatyy.perf.pending.v1"
private let kLiveKey = "chatyy.perf.live.v1"
private let kExitsKey = "chatyy.perf.exits.v1"
private let kSeqKey = "chatyy.perf.seq.v1"
private let kWindowSec: Double = 60
private let kMemTickSec: Double = 5
private let kFrozenSec: Double = 0.7
private let kMaxPending = 30
private let kMaxExits = 12
private let kMaxRoutes = 24

private struct PerfBucket {
  var n = 0
  var sl = 0
  var fz = 0
  var mx = 0.0
  var j = 0.0
  var isEmpty: Bool { n == 0 && sl == 0 && fz == 0 }
}

final class ChatyyPerfCore: NSObject, MXMetricManagerSubscriber {
  static let shared = ChatyyPerfCore()

  // fila/saídas: acessadas do main (fecha janela), do JS (peek/ack) e do MetricKit
  private let lock = NSLock()
  private var pending: [[String: Any]] = []
  private var exits: [[String: Any]] = []
  private var seq: Int = 0
  private(set) var prevSession: [String: Any]?
  private var lastStats: [String: Any] = [:]

  // ── só main thread ──
  private var running = false
  private var link: CADisplayLink?
  private var memTimer: Timer?
  private var lastTs: CFTimeInterval = 0
  private var route = ""
  private var cur = PerfBucket()
  private var buckets: [String: PerfBucket] = [:]
  private var winStart = Date()
  private var memTicks = 0
  private var memPkWin = 0.0
  private var memPkSession = 0.0
  private var memCur = 0.0
  private var availMinWin = -1.0
  private var warnWin = 0
  private var warnSession = 0
  private var fg = false
  private var lastFrozenAt: Double = 0
  private var lastFrozenMs = 0.0
  private var sessionStart = Date()
  private var refresh = 60

  var emit: (([String: Any]) -> Void)?

  private override init() {
    super.init()
    let ud = UserDefaults.standard
    // sessão anterior: lê ANTES de qualquer gravação deste processo
    if let d = ud.data(forKey: kLiveKey),
       let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
      prevSession = o
    }
    ud.removeObject(forKey: kLiveKey)
    if let d = ud.data(forKey: kPendingKey),
       let a = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] {
      pending = Array(a.suffix(kMaxPending))
    }
    if let d = ud.data(forKey: kExitsKey),
       let a = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] {
      exits = Array(a.suffix(kMaxExits))
    }
    seq = ud.integer(forKey: kSeqKey)
    MXMetricManager.shared.add(self)
  }

  // MARK: - ciclo (main)

  func start() {
    if running { return }
    running = true
    sessionStart = Date()
    winStart = Date()
    refresh = max(30, UIScreen.main.maximumFramesPerSecond)
    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(onActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    nc.addObserver(self, selector: #selector(onResign), name: UIApplication.willResignActiveNotification, object: nil)
    nc.addObserver(self, selector: #selector(onBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(onTerminate), name: UIApplication.willTerminateNotification, object: nil)
    nc.addObserver(self, selector: #selector(onMemoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
    let l = CADisplayLink(target: PerfWeakProxy(self), selector: #selector(PerfWeakProxy.tick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
    let t = Timer(timeInterval: kMemTickSec, repeats: true) { [weak self] _ in self?.memTick() }
    t.tolerance = 1
    RunLoop.main.add(t, forMode: .common)
    memTimer = t
    fg = UIApplication.shared.applicationState == .active
    l.isPaused = !fg
    sampleMemory()
    writeLive(term: false)
  }

  func stop() {
    if !running { return }
    closeWindow(reason: "stop")
    running = false
    link?.invalidate(); link = nil
    memTimer?.invalidate(); memTimer = nil
    NotificationCenter.default.removeObserver(self)
  }

  func setRoute(_ r: String) {
    if r == route { return }
    foldCurrent()
    route = r
  }

  fileprivate func onFrame(_ l: CADisplayLink) {
    let ts = l.timestamp
    var budget = l.targetTimestamp - ts
    if !(budget > 0.004 && budget < 0.05) { budget = 1.0 / Double(refresh) }
    if lastTs > 0 {
      let dt = ts - lastTs
      cur.n += 1
      if dt >= kFrozenSec {
        cur.fz += 1
        lastFrozenAt = Date().timeIntervalSince1970
        lastFrozenMs = dt * 1000
      } else if dt > 2 * budget {
        cur.sl += 1
      }
      if dt > budget * 1.5 { cur.j += (dt - budget) * 1000 }
      let ms = dt * 1000
      if ms > cur.mx { cur.mx = ms }
    }
    lastTs = ts
  }

  private func foldCurrent() {
    if cur.isEmpty { return }
    var key = route.isEmpty ? "-" : route
    if buckets[key] == nil && buckets.count >= kMaxRoutes { key = "other" }
    var b = buckets[key] ?? PerfBucket()
    b.n += cur.n; b.sl += cur.sl; b.fz += cur.fz; b.j += cur.j
    if cur.mx > b.mx { b.mx = cur.mx }
    buckets[key] = b
    cur = PerfBucket()
  }

  private func memTick() {
    sampleMemory()
    memTicks += 1
    if Double(memTicks) * kMemTickSec >= kWindowSec { closeWindow(reason: "t") }
  }

  private func sampleMemory() {
    let mb = ChatyyPerfCore.physFootprintMB()
    if mb > 0 {
      memCur = mb
      if mb > memPkWin { memPkWin = mb }
      if mb > memPkSession { memPkSession = mb }
    }
    let av = Double(os_proc_available_memory()) / 1048576.0
    if av > 0 && (availMinWin < 0 || av < availMinWin) { availMinWin = av }
  }

  private func closeWindow(reason: String) {
    foldCurrent()
    memTicks = 0
    let now = Date()
    let hasData = !buckets.isEmpty || warnWin > 0
    if hasData {
      var rts: [[String: Any]] = []
      for (k, b) in buckets {
        rts.append(["r": k, "n": b.n, "sl": b.sl, "fz": b.fz, "mx": Int(b.mx.rounded()), "j": Int(b.j.rounded())])
      }
      var w: [String: Any] = [
        "t0": Int(winStart.timeIntervalSince1970), "t1": Int(now.timeIntervalSince1970),
        "rr": refresh, "rt": rts,
        "pk": Int(memPkWin.rounded()), "cur": Int(memCur.rounded()),
        "mw": warnWin, "why": reason,
      ]
      if availMinWin >= 0 { w["av"] = Int(availMinWin.rounded()) }
      lock.lock()
      seq += 1
      w["s"] = seq
      pending.append(w)
      if pending.count > kMaxPending { pending.removeFirst(pending.count - kMaxPending) }
      let snapshot = pending
      let s = seq
      lock.unlock()
      persist(snapshot, key: kPendingKey)
      UserDefaults.standard.set(s, forKey: kSeqKey)
    }
    buckets.removeAll(keepingCapacity: true)
    winStart = now
    memPkWin = memCur
    availMinWin = -1
    warnWin = 0
    writeLive(term: false)
    if hasData { emit?(["why": reason]) }
  }

  private func writeLive(term: Bool) {
    var o: [String: Any] = [
      "t": Int(Date().timeIntervalSince1970), "r": route, "fg": fg ? 1 : 0,
      "pk": Int(memPkSession.rounded()), "cur": Int(memCur.rounded()), "mw": warnSession,
      "up": Int(Date().timeIntervalSince(sessionStart)),
    ]
    if term { o["term"] = 1 }
    if lastFrozenAt > 0 { o["lzt"] = Int(lastFrozenAt); o["lzm"] = Int(lastFrozenMs.rounded()) }
    let av = Double(os_proc_available_memory()) / 1048576.0
    if av > 0 { o["av"] = Int(av.rounded()) }
    if let d = try? JSONSerialization.data(withJSONObject: o) { UserDefaults.standard.set(d, forKey: kLiveKey) }
    lock.lock(); lastStats = o; lock.unlock()
  }

  @objc private func onActive() {
    fg = true
    lastTs = 0 // o intervalo em 2º plano não é quadro congelado
    link?.isPaused = false
    writeLive(term: false)
  }

  @objc private func onResign() {
    link?.isPaused = true
    lastTs = 0
  }

  @objc private func onBackground() {
    fg = false
    closeWindow(reason: "bg")
  }

  @objc private func onTerminate() {
    fg = false
    writeLive(term: true)
  }

  @objc private func onMemoryWarning() {
    warnWin += 1
    warnSession += 1
    sampleMemory()
    writeLive(term: false)
  }

  // MARK: - leitura (JS thread)

  func peek() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    var o: [String: Any] = ["windows": pending, "exits": exits, "seq": seq]
    if let p = prevSession { o["prev"] = p }
    return o
  }

  func ack(_ upTo: Int, exitsCount: Int, prev: Bool) {
    lock.lock()
    pending.removeAll { (($0["s"] as? Int) ?? 0) <= upTo }
    if exitsCount > 0 { exits.removeFirst(min(exitsCount, exits.count)) }
    if prev { prevSession = nil }
    let p = pending, e = exits
    lock.unlock()
    persist(p, key: kPendingKey)
    persist(e, key: kExitsKey)
  }

  func stats() -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    var o = lastStats
    o["pending"] = pending.count
    o["exits"] = exits.count
    return o
  }

  private func persist(_ a: [[String: Any]], key: String) {
    if a.isEmpty { UserDefaults.standard.removeObject(forKey: key); return }
    if let d = try? JSONSerialization.data(withJSONObject: a) { UserDefaults.standard.set(d, forKey: key) }
  }

  private func addExit(_ e: [String: Any]) {
    lock.lock()
    exits.append(e)
    if exits.count > kMaxExits { exits.removeFirst(exits.count - kMaxExits) }
    let snapshot = exits
    lock.unlock()
    persist(snapshot, key: kExitsKey)
    DispatchQueue.main.async { [weak self] in self?.emit?(["why": "exit"]) }
  }

  // MARK: - MetricKit (fila arbitrária)

  func didReceive(_ payloads: [MXMetricPayload]) {
    for p in payloads {
      var o: [String: Any] = [
        "k": "mx_metric",
        "t0": Int(p.timeStampBegin.timeIntervalSince1970), "t1": Int(p.timeStampEnd.timeIntervalSince1970),
        "av": String(p.latestApplicationVersion.prefix(16)),
      ]
      if let md = p.metaData {
        o["bv"] = String(md.applicationBuildVersion.prefix(16))
        o["os"] = String(md.osVersion.prefix(24))
        o["dev"] = String(md.deviceType.prefix(16))
      }
      if let ex = p.applicationExitMetrics {
        let f = ex.foregroundExitData
        let b = ex.backgroundExitData
        o["fg"] = ChatyyPerfCore.nonZero([
          "normal": f.cumulativeNormalAppExitCount,
          "mem_limit": f.cumulativeMemoryResourceLimitExitCount,
          "bad_access": f.cumulativeBadAccessExitCount,
          "abnormal": f.cumulativeAbnormalExitCount,
          "illegal_instr": f.cumulativeIllegalInstructionExitCount,
          "watchdog": f.cumulativeAppWatchdogExitCount,
        ])
        o["bg"] = ChatyyPerfCore.nonZero([
          "normal": b.cumulativeNormalAppExitCount,
          "mem_limit": b.cumulativeMemoryResourceLimitExitCount,
          "mem_pressure": b.cumulativeMemoryPressureExitCount,
          "cpu_limit": b.cumulativeCPUResourceLimitExitCount,
          "bad_access": b.cumulativeBadAccessExitCount,
          "abnormal": b.cumulativeAbnormalExitCount,
          "illegal_instr": b.cumulativeIllegalInstructionExitCount,
          "watchdog": b.cumulativeAppWatchdogExitCount,
          "locked_file": b.cumulativeSuspendedWithLockedFileExitCount,
          "bg_task_timeout": b.cumulativeBackgroundTaskAssertionTimeoutExitCount,
        ])
      }
      if let mm = p.memoryMetrics {
        o["mem_pk"] = Int(mm.peakMemoryUsage.converted(to: .megabytes).value.rounded())
      }
      if let rm = p.applicationResponsivenessMetrics {
        var hist: [[Int]] = []
        let en = rm.histogrammedApplicationHangTime.bucketEnumerator
        while let bk = en.nextObject() as? MXHistogramBucket<UnitDuration> {
          if bk.bucketCount <= 0 { continue }
          hist.append([Int(bk.bucketStart.converted(to: .milliseconds).value.rounded()), bk.bucketCount])
          if hist.count >= 8 { break }
        }
        if !hist.isEmpty { o["hang"] = hist }
      }
      addExit(o)
    }
  }

  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    for p in payloads {
      var o: [String: Any] = [
        "k": "mx_diag",
        "t0": Int(p.timeStampBegin.timeIntervalSince1970), "t1": Int(p.timeStampEnd.timeIntervalSince1970),
      ]
      var crashes: [[String: Any]] = []
      for c in (p.crashDiagnostics ?? []).prefix(3) {
        var x: [String: Any] = ["bv": String(c.metaData.applicationBuildVersion.prefix(16))]
        if let v = c.exceptionType { x["et"] = v.intValue }
        if let v = c.exceptionCode { x["ec"] = v.intValue }
        if let v = c.signal { x["sig"] = v.intValue }
        if let v = c.terminationReason { x["tr"] = String(v.prefix(110)) }
        if let v = c.virtualMemoryRegionInfo { x["vm"] = String(v.prefix(80)) }
        if #available(iOS 17.0, *), let r = c.exceptionReason {
          x["exn"] = String("\(r.exceptionName): \(r.composedMessage)".prefix(110))
        }
        let fr = ChatyyPerfCore.topFrames(c.callStackTree, max: 6)
        if !fr.isEmpty { x["fr"] = fr }
        crashes.append(x)
      }
      if !crashes.isEmpty { o["crash"] = crashes }
      var hangs: [[String: Any]] = []
      for h in (p.hangDiagnostics ?? []).prefix(3) {
        var x: [String: Any] = [
          "bv": String(h.metaData.applicationBuildVersion.prefix(16)),
          "ms": Int(h.hangDuration.converted(to: .milliseconds).value.rounded()),
        ]
        let fr = ChatyyPerfCore.topFrames(h.callStackTree, max: 4)
        if !fr.isEmpty { x["fr"] = fr }
        hangs.append(x)
      }
      if !hangs.isEmpty { o["hang"] = hangs }
      let cpu = p.cpuExceptionDiagnostics?.count ?? 0
      let disk = p.diskWriteExceptionDiagnostics?.count ?? 0
      if cpu > 0 { o["cpu"] = cpu }
      if disk > 0 { o["disk"] = disk }
      if crashes.isEmpty && hangs.isEmpty && cpu == 0 && disk == 0 { continue }
      addExit(o)
    }
  }

  // MARK: - util

  static func nonZero(_ d: [String: Int]) -> [String: Int] {
    return d.filter { $0.value > 0 }
  }

  /// ≤ max quadros "binário+offset" da thread atribuída (ou a 1ª) — nunca a árvore crua.
  static func topFrames(_ tree: MXCallStackTree, max: Int) -> [String] {
    let data = tree.jsonRepresentation()
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let stacks = root["callStacks"] as? [[String: Any]], !stacks.isEmpty else { return [] }
    let st = stacks.first { ($0["threadAttributed"] as? Bool) == true } ?? stacks[0]
    guard let roots = st["callStackRootFrames"] as? [[String: Any]], var f = roots.first else { return [] }
    var out: [String] = []
    while out.count < max {
      let bin = String(((f["binaryName"] as? String) ?? "?").prefix(32))
      let off = (f["offsetIntoBinaryTextSegment"] as? NSNumber)?.int64Value ?? 0
      out.append("\(bin)+0x\(String(off, radix: 16))")
      guard let subs = f["subFrames"] as? [[String: Any]], let n = subs.first else { break }
      f = n
    }
    return out
  }

  static func physFootprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard kr == KERN_SUCCESS else { return -1 }
    return Double(info.phys_footprint) / 1048576.0
  }
}

/// CADisplayLink retém o alvo → proxy fraco (o núcleo é singleton, mas sem ciclo mesmo assim).
private final class PerfWeakProxy: NSObject {
  weak var target: ChatyyPerfCore?
  init(_ t: ChatyyPerfCore) { target = t }
  @objc func tick(_ l: CADisplayLink) {
    if let t = target { t.onFrame(l) } else { l.invalidate() }
  }
}

public class ChatyyPerfModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ChatyyPerf")
    Events("onPerfWindow")

    OnCreate {
      // assina o MetricKit cedo (payloads chegam no início do processo)
      let core = ChatyyPerfCore.shared
      core.emit = { [weak self] body in self?.sendEvent("onPerfWindow", body) }
    }

    OnDestroy {
      ChatyyPerfCore.shared.emit = nil
    }

    // 1 = quadros/memória/prev/MetricKit (2026-10-18)
    Function("apiVersion") { () -> Int in
      return 1
    }

    Function("start") { (opts: [String: Any]) -> Bool in
      _ = opts
      DispatchQueue.main.async { ChatyyPerfCore.shared.start() }
      return true
    }

    Function("stop") { () -> Bool in
      DispatchQueue.main.async { ChatyyPerfCore.shared.stop() }
      return true
    }

    Function("setRoute") { (r: String) in
      let route = String(r.prefix(48))
      DispatchQueue.main.async { ChatyyPerfCore.shared.setRoute(route) }
    }

    // { windows: [...], exits: [...], prev?: {...}, seq } — não destrutivo
    Function("peek") { () -> [String: Any] in
      return ChatyyPerfCore.shared.peek()
    }

    // confirma o que já foi enviado: janelas com s ≤ seq, as N primeiras saídas, prev
    Function("ack") { (seq: Int, exitsCount: Int, prev: Bool) in
      ChatyyPerfCore.shared.ack(seq, exitsCount: exitsCount, prev: prev)
    }

    Function("stats") { () -> [String: Any] in
      return ChatyyPerfCore.shared.stats()
    }
  }
}
