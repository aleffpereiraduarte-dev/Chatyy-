// Smoke Swift do núcleo TEMPORÁRIO (prova): bindings UniFFI geradas + lib do host.
// Roda no macOS (CI) e também é linkado para arm64-apple-ios (app e NSE) pelo build-ios.sh.
import Foundation

let v = coreVersion()
precondition(v.hasPrefix("chatyy-crypto"), "coreVersion inesperado")
let msg = "Olá, isto é E2EE de verdade 🔒"
let out = try await provaRoundtrip(text: msg)
precondition(out == msg, "roundtrip divergente")
let dir = NSTemporaryDirectory() + "chatyy-prova-\(ProcessInfo.processInfo.processIdentifier)"
let n = try await provaStoreOpen(dir: dir, passphrase: String(repeating: "k", count: 32))
precondition(n == 43, "store")
try? FileManager.default.removeItem(atPath: dir)
print("SWIFT SMOKE OK: \(v) | roundtrip Olm/Megolm ok | store SQLite ok")
