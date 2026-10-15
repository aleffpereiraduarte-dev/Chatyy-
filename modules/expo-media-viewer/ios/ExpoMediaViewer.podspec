require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoMediaViewer'
  s.version        = package['version']
  s.summary        = 'Chatyy native fullscreen media viewer'
  s.description    = 'UICollectionView paging viewer with UIScrollView zoom pages (photos) and AVPlayerLayer pages (videos), swipe-down dismiss, chrome bars and JS action callbacks.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'AVFoundation', 'ImageIO', 'CryptoKit', 'CoreMedia', 'QuartzCore', 'Photos'
end
