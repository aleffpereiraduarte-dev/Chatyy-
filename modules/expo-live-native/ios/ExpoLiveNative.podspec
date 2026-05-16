require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoLiveNative'
  s.version        = package['version']
  s.summary        = 'Native SwiftUI host/viewer for LiveKit-backed live broadcasts.'
  s.description    = <<~DESC
    Presents fullscreen SwiftUI host and viewer screens that drive the
    LiveKit Swift SDK directly. Removes the @livekit/react-native VideoView
    from the render path to fix the flicker/mancha issues we were seeing in
    the JS implementation.
  DESC
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # LiveKit Swift SDK is pulled in transitively by @livekit/react-native (the
  # JS package installs LiveKitClient via its own podspec). We don't redeclare
  # the dependency here to avoid version drift — whatever version the JS
  # package pins is the one we link against.

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.swift'

  s.frameworks = 'AVFoundation', 'UIKit', 'SwiftUI', 'Combine'
end
