require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoStatusStudio'
  s.version        = package['version']
  s.summary        = 'Chatyy native status creator'
  s.description    = 'Fullscreen UIKit status studio: text status (colors/gradients, fonts, auto-fit), photo/video layers (text, emoji, location, mention, link, poll, question, countdown, music), brushes, CIColorMatrix filters, audience and publish handoff to JS.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'AVFoundation', 'CoreImage', 'ImageIO', 'CoreMedia', 'QuartzCore'
end
