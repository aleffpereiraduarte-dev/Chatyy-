// swift-tools-version:5.9
// [2026-10-23 quic-proto] Testes FORA do iOS (Linux/macOS) das partes sem rede do fio QUIC:
//   swift run NoiseSelfTest                      → vetores + ida e volta
//   (cd gointerop && go run . ) | ...             → ver LEIA no topo de gointerop/main.go
// Não entra no app: o podspec só compila ../ios/**/*.swift.
import PackageDescription
let package = Package(
  name: "ChatyyQuicTests",
  dependencies: [.package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"4.0.0")],
  targets: [
    .executableTarget(name: "NoiseSelfTest", dependencies: [.product(name: "Crypto", package: "swift-crypto")]),
    .executableTarget(name: "Interop", dependencies: [.product(name: "Crypto", package: "swift-crypto")]),
  ]
)
