require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatAttach'
  s.version        = package['version']
  s.summary        = 'Chatyy native attachment sheet + chat camera'
  s.description    = 'Telegram-style attachment sheet (PhotoKit grid, live AVCaptureSession tile, numbered multi-select, caption/HD/as-file) and WhatsApp-style chat camera (tap photo, hold video + slide-up zoom, flash, double-tap flip, recent strip).'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'AVFoundation', 'Photos', 'PhotosUI', 'ImageIO', 'CoreMedia', 'QuartzCore', 'UniformTypeIdentifiers'
end
