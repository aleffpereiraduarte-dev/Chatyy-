require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoInAppBanner'
  s.version        = package['version']
  s.summary        = 'Chatyy native in-app notification banner'
  s.description    = 'Pass-through UIWindow overlay with a blurred banner (avatar, name, preview), UIKit spring animations on the render server, pan to dismiss / expand to quick reply.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'QuartzCore'
end
