import Foundation
import Glibc
import Crypto
let args = CommandLine.arguments
let hp = args[1].split(separator: ":"); let pub = Data(base64Encoded: args[2])!
let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
var sa = sockaddr_in(); sa.sin_family = sa_family_t(AF_INET); sa.sin_port = in_port_t(UInt16(hp[1])!).bigEndian
inet_pton(AF_INET, String(hp[0]), &sa.sin_addr)
let rc = withUnsafePointer(to: &sa) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
precondition(rc == 0, "connect")
func w(_ d: Data) { d.withUnsafeBytes { p in var o = 0; while o < d.count { let n = write(fd, p.baseAddress! + o, d.count - o); precondition(n > 0); o += n } } }
let dev = Curve25519.KeyAgreement.PrivateKey()
print("dev pub", dev.publicKey.rawRepresentation.base64EncodedString())
let pro = ChatyyQuicProto.prologue(region: "mex", kid: "t1", wire: 0x74, mode: ChatyyQuicProto.modeI, binding: Data())
let ch = try ChatyyQuicChannel(region: "mex", kid: "t1", regionPub: pub, deviceKey: dev, prologue: pro)
w(try ch.clientHello(mode: ChatyyQuicProto.modeI, payload: ChatyyQuicChannel.helloPayload(dev: "devX", ua: "swift-interop", nowMs: Date().timeIntervalSince1970 * 1000)))
var buf = [UInt8](repeating: 0, count: 65536); var done = false; var sentText = false
while !done {
  let n = read(fd, &buf, buf.count); if n <= 0 { print("EOF"); break }
  let r = try ch.receive(Data(buf[0..<n]))
  if !r.reply.isEmpty { w(r.reply) }
  for e in r.events {
    switch e {
    case .ready(let b): print("READY bound=\(b)"); if !sentText { sentText = true; w(try ch.sealText("{\"type\":\"auth\",\"token\":\"x\"}")) }
    case .text(let t): print("TEXT", t.prefix(40), t.utf8.count)
    case .close(let c, let s): print("CLOSE", c, s); done = true
    case .binary(let n): print("BIN", n)
    }
  }
}
