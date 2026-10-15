require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatMessageList'
  s.version        = package['version']
  s.summary        = 'Chatyy native chat message list'
  s.description    = 'Inverted UICollectionView with hand-laid-out bubble cells (CoreText text layout computed on a background queue, height cache, inline time/ticks, reply quote, image/sticker/video/audio/file cells, swipe-to-reply).'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # [native-store] foto da conversa lida/gravada direto no store nativo
  s.dependency 'ExpoChatStore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'CoreText', 'ImageIO', 'CryptoKit', 'QuartzCore', 'AVFoundation', 'Network'
end
