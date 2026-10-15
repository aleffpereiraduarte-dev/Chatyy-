require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatConversationList'
  s.version        = package['version']
  s.summary        = 'Chatyy native home conversation list'
  s.description    = 'UICollectionView compositional list with diffable data source, swipe actions, context menu peek, CoreGraphics status ring and disk-cached avatars.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # [2026-10-15 native-store fase 1.5] foto da home lida/gravada direto no store nativo
  s.dependency 'ExpoChatStore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'ImageIO', 'CryptoKit', 'QuartzCore'
end
