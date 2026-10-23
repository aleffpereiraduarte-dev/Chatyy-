import Foundation
// Vetores Noise (cacophony IK BLAKE2s + SHA256, RFC 7693) + ida e volta do canal chatyy/1.
if let e = ChatyyQuicSelfTest.run() { print("FAIL", e); exit(1) }
print("QUIC+NOISE SELFTEST OK")
