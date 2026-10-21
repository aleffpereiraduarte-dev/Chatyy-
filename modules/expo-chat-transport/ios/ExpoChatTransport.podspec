require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# [e2ee5 WP-08a 2026-10-21] Núcleo E2EE (chatyy-crypto) no binário? Mesma regra do
# modules/expo-chatyy-crypto/ios/ExpoChatyyCrypto.podspec (WP-03): xcframework + bindings
# presentes e CHATYY_CRYPTO_CORE != '0'. Sem núcleo (todo build normal) = este podspec é o de
# sempre: sem dependência nova, sem define → ChatOutbox/ingest/ponte = comportamento de hoje.
crypto_ios = File.join(__dir__, '..', '..', 'expo-chatyy-crypto', 'ios')
e2ee_core = File.directory?(File.join(crypto_ios, 'ChatyyCryptoCore.xcframework')) &&
            File.size?(File.join(crypto_ios, 'Generated', 'ChatyyCryptoCore.swift')) &&
            (ENV['CHATYY_CRYPTO_CORE'] || '').strip != '0'
Pod::UI.puts "[expo-chat-transport] E2EE nativo #{e2ee_core ? 'LIGADO (núcleo)' : 'desligado (sem núcleo)'}"

Pod::Spec.new do |s|
  s.name           = 'ExpoChatTransport'
  s.version        = package['version']
  s.summary        = 'Chatyy native realtime transport'
  s.description    = 'Native-owned WebSocket to the Chatyy Go hub (URLSessionWebSocketTask + NWPathMonitor): keepalive, zombie detection, reconnect on network change, outbox, batched frames to JS.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # [2026-10-15 fase 2b/4] grava direto no store nativo + fila de envio nativa
  s.dependency 'ExpoChatStore'

  s.source_files = '**/*.swift'

  if e2ee_core
    # ChatyyCrypto.shared + tipos UniFFI vêm do pod do WP-03; o módulo clang ChatyyCryptoCoreFFI
    # (headers do xcframework) precisa estar visível para importar o swiftmodule dele.
    s.dependency 'ExpoChatyyCrypto'
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) CHATYY_CRYPTO_CORE',
      'SWIFT_INCLUDE_PATHS' => '$(inherited) "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoChatyyCrypto/Headers"',
      'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_XCFRAMEWORKS_BUILD_DIR}/ExpoChatyyCrypto/Headers"',
    }
  end

  s.frameworks = 'Foundation', 'Network', 'UIKit', 'BackgroundTasks', 'Security'
end
