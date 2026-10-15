require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoMediaEditor'
  s.version        = package['version']
  s.summary        = 'Chatyy native photo/video editor before sending'
  s.description    = 'Fullscreen UIKit editor: crop/rotate with ratios, drawing, text and sticker objects, CIColorMatrix filters, video trim (thumbnail rail), mute and cover; caption, view-once and HD for the chat/status send flow.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'AVFoundation', 'CoreImage', 'ImageIO', 'CoreMedia', 'QuartzCore'
end
