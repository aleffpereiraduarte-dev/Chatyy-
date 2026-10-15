require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoReelsFeed'
  s.version        = package['version']
  s.summary        = 'Chatyy native Reels feed'
  s.description    = 'Vertical paged UICollectionView (1 video per screen) with a 3-slot AVPlayer pool (previous/current/next), pre-buffer, disk prefetch of upcoming MP4s, loop, tap mute, long-press hold, double-tap like (Core Animation heart), progress/scrub bar and native action rail.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'AVFoundation', 'ImageIO', 'CryptoKit', 'QuartzCore'
end
