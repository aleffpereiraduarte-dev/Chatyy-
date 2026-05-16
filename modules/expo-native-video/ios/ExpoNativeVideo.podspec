require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoNativeVideo'
  s.version        = package['version']
  s.summary        = 'Native video compression + thumbnail + info for Chatyy chat uploads'
  s.description    = 'AVAssetExportSession-backed H.264 transcode, AVAssetImageGenerator thumbnails, and AVURLAsset info for the chat video upload pipeline.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  # AVFoundation = export sessions, asset readers, image generator.
  # UIKit       = UIImage → JPEG encode for thumbnail output.
  # CoreMedia   = CMTime for the image generator's `requestedTimeToleranceBefore/After`.
  s.frameworks = 'AVFoundation', 'UIKit', 'CoreMedia'
end
