# E2EE v4 nativo — vodozemac (Rust) em ChatyyE2EECore.xcframework + bindings
# UniFFI (Generated/ChatyyE2EECore.swift) + o módulo Expo (ChatyyE2EEModule.swift).
# Os dois primeiros são gerados por native/e2ee/rust/build-ios.sh (CI macOS).
Pod::Spec.new do |s|
  s.name           = 'expo-chatyy-e2ee'
  s.version        = '0.1.0'
  s.summary        = 'Chatyy E2EE v4 (vodozemac / Olm) native core'
  s.description    = 'Thin Expo module over vodozemac (matrix-org, Apache-2.0) compiled from Rust with UniFFI. Same API and wire format as the web wasm build.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.license        = { :type => 'Apache-2.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  unless File.exist?(File.join(__dir__, 'ChatyyE2EECore.xcframework')) && File.exist?(File.join(__dir__, 'Generated', 'ChatyyE2EECore.swift'))
    raise '[expo-chatyy-e2ee] faltam ChatyyE2EECore.xcframework / Generated/ChatyyE2EECore.swift — rode native/e2ee/rust/build-ios.sh'
  end
  s.vendored_frameworks = 'ChatyyE2EECore.xcframework'
  # Explícito: NÃO pegar os .h de dentro do xcframework como fonte.
  s.source_files = 'ChatyyE2EEModule.swift', 'Generated/ChatyyE2EECore.swift'
  s.frameworks = 'Security'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
