import Foundation
// Vetores Noise (cacophony IK BLAKE2s + SHA256, RFC 7693) + ida e volta do canal chatyy/1.
// + os 11 vetores do certificado de região (PROTOCOLO §9.2, raiz de TESTE vr1) + prefixo 0-RTT do §5.
if let e = ChatyyQuicSelfTest.run() { print("FAIL", e); exit(1) }
print("QUIC+NOISE SELFTEST OK")
