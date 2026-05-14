require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'expo-screen-share'
  s.version        = package['version']
  s.summary        = 'iOS screen share via ReplayKit Broadcast Extension'
  s.description    = 'Exposes RPSystemBroadcastPickerView and an App Group IPC pump that pipes frames from the Chatyy Broadcast Extension into the WebRTC video sender.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift}'

  s.frameworks = 'ReplayKit', 'UIKit'
end
