require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoNativeTabBar'
  s.version        = package['version']
  s.summary        = 'Chatyy native bottom tab bar'
  s.description    = 'UITabBar host view (system material blur, SF Symbols, badges, spring icon bounce, haptics) for the Chatyy home.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'QuartzCore'
end
