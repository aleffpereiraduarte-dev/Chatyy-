require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatEmoji'
  s.version        = package['version']
  s.summary        = 'Chatyy native emoji / sticker / GIF panel'
  s.description    = 'UICollectionView emoji grid (categories, recents, search, skin tones), sticker packs and GIF grid with ImageIO animated decoding.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'ImageIO', 'CryptoKit', 'QuartzCore'
end
