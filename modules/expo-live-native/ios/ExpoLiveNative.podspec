require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoLiveNative'
  s.version        = package['version']
  s.summary        = 'Native Live host + viewer module for Chatyy'
  s.description    = 'LiveKit-backed native fullscreen Live broadcast UI (host + viewer).'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # [Stage 1 scaffold, 2026-05-16] LiveKit Swift SDK declared up front so CI
  # proves the pod resolves before Stage 2 wires LiveHostViewController +
  # LiveViewerViewController against `import LiveKit`. Pinned ~> 2.0 to match
  # the JS livekit-client ^2.19 and to share the SDK install with the
  # ExpoCallKit pod entry (same version constraint).
  s.dependency 'LiveKitClient', '~> 2.0'

  s.source_files = '**/*.swift'

  s.frameworks = 'AVFoundation', 'UIKit'
end
