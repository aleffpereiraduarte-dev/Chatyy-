// Smoke Swift do núcleo REAL (CONTRATO §6): funções livres, mídia, HttpTransport estrangeiro
// (Swift → Rust) e CryptoCore.open async com store SQLite. Sem rede (open não chama o host).
// Roda no macOS (CI) e é linkado para arm64-apple-ios (app e NSE) pelo build-ios.sh.
import Foundation

final class SemRede: HttpTransport, @unchecked Sendable {
    func call(action: String, bodyJson: String) async throws -> HttpResponse {
        HttpResponse(status: 503, body: "{\"success\":false,\"data\":{\"code\":\"smoke\"}}")
    }
}

let v = coreVersion()
precondition(v.hasPrefix("chatyy-crypto "), "coreVersion inesperado")
precondition(envelopeVersion(content: "{\"e2e\":5,\"c\":{}}") == 5, "envelopeVersion")
let dev = try newDeviceId(platformPrefix: "P")
let plain = Data("foto 🔒".utf8)
let enc = try encryptBytes(plain: plain)
precondition(try decryptBytes(data: enc.data, infoJson: enc.infoJson) == plain, "mídia")
let dir = NSTemporaryDirectory() + "chatyy-smoke-\(ProcessInfo.processInfo.processIdentifier)"
let core = try await CryptoCore.open(
    opts: OpenOptions(storeDir: dir, storePassphrase: String(repeating: "k", count: 32), uid: "1",
                      deviceId: dev, role: .app, holderSuffix: "smoke"),
    transport: SemRede())
let me = try await core.thisDevice()
precondition(me.deviceId == dev && me.ed25519.count == 43, "thisDevice")
try? FileManager.default.removeItem(atPath: dir)
print("SWIFT SMOKE OK: \(v) | device \(dev.count) chars | mídia ok | CryptoCore.open+thisDevice ok")
