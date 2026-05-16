require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoShorts'
  s.version        = package['version']
  s.summary        = package['description'] || 'Expo module for Shorts/Reels native player'
  s.description    = 'Native Shorts/Reels player for Expo. Stage 1 scaffold — placeholder view + no-op prefetch. Stage 2 wires AVPlayer.'
  s.author         = 'Chatyy / OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # iOS uses AVPlayer (AVFoundation, system framework — already linked). No
  # third-party pod needed. AVFoundation is added below via s.frameworks so
  # Stage 2 can `import AVFoundation` without a podspec change.

  s.source_files = '**/*.swift'

  s.frameworks = 'AVFoundation', 'UIKit'
end
