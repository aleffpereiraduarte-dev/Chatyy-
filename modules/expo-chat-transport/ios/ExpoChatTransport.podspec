require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

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

  s.frameworks = 'Foundation', 'Network', 'UIKit', 'BackgroundTasks', 'Security'
end
