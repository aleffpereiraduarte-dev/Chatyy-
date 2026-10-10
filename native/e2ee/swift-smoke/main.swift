// Smoke test das bindings Swift geradas pelo UniFFI (macOS, CI e2ee-core.yml).
// Compila Generated/ChatyyE2EECore.swift + este arquivo contra a lib do host
// e abre um vetor do wasm (native/e2ee/vectors/wasm-to-native.json).
import Foundation

func fail(_ m: String) -> Never { print("FAIL", m); exit(1) }

let key = Data(repeating: 7, count: 32)
let a = OlmAccount(), b = OlmAccount()
b.generateOneTimeKeys(count: 2)
let otks = try! JSONSerialization.jsonObject(with: b.oneTimeKeys().data(using: .utf8)!) as! [String: String]
let otk = otks.values.first!
b.markKeysAsPublished()
let sa = try! a.createOutboundSession(identityKeyB64: b.curve25519(), oneTimeKeyB64: otk)
let m = try! JSONSerialization.jsonObject(with: try! sa.encrypt(plaintext: "oi swift").data(using: .utf8)!) as! [String: Any]
let t = UInt32(m["t"] as! Int), body = m["b"] as! String
let r = try! b.createInboundSession(theirIdentityKeyB64: a.curve25519(), msgType: t, bodyB64: body)
if r.plaintext != "oi swift" { fail("plaintext") }
if preKeySessionId(msgType: t, bodyB64: body) != sa.sessionId() { fail("sid") }
do { _ = try OlmSession.fromPickle(pickle: try sa.pickle(pickleKey: key), pickleKey: Data(count: 32)); fail("wrong key accepted") } catch is E2eeError { print("ok wrong key") } catch { fail("unexpected \(error)") }
do { _ = try r.session.decrypt(msgType: t, bodyB64: body); fail("replay accepted") } catch { print("ok replay rejected") }

let v = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
let pk = Data(base64Encoded: v["pickle_key"] as! String)!
let bobV = v["bob"] as! [String: Any], aliceV = v["alice"] as! [String: Any]
let bob = try! OlmAccount.fromPickle(pickle: bobV["account_pickle"] as! String, pickleKey: pk)
if bob.curve25519() != bobV["curve25519"] as! String { fail("bob curve") }
let msgs = v["messages"] as! [[String: Any]]
let rr = try! bob.createInboundSession(theirIdentityKeyB64: aliceV["curve25519"] as! String, msgType: 0, bodyB64: msgs[0]["b"] as! String)
if rr.plaintext != msgs[0]["pt"] as! String { fail("wasm vector") }
for x in msgs.dropFirst() {
  if try! rr.session.decrypt(msgType: UInt32(x["t"] as! Int), bodyB64: x["b"] as! String) != x["pt"] as! String { fail("wasm vector n") }
}
if !ed25519Verify(publicKeyB64: bobV["ed25519"] as! String, message: bobV["otk_sig_msg"] as! String, signatureB64: bobV["otk_sig"] as! String) { fail("sig") }
print("SWIFT OK —", coreVersion())
