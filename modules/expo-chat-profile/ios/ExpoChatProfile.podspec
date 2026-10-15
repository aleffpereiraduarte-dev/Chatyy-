require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatProfile'
  s.version        = package['version']
  s.summary        = 'Chatyy native contact / group info'
  s.description    = 'Collapsing profile header over the RN ScrollView, photo gallery, media tabs grid and member list.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'ImageIO', 'CryptoKit', 'QuartzCore'
end
