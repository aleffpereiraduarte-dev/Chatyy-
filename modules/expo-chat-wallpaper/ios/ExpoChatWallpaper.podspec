require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatWallpaper'
  s.version        = package['version']
  s.summary        = 'Chatyy native chat wallpaper'
  s.description    = 'Animated 4-color gradient (CPU 60x80 bitmap, upscaled by Core Animation, redrawn only while animating), vector doodle pattern tile (overlay or mask), blurred photo and UIMotionEffect parallax.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'QuartzCore', 'CoreImage', 'ImageIO'
end
