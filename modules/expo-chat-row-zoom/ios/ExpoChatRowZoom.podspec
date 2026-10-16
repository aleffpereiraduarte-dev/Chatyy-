require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatRowZoom'
  s.version        = package['version']
  s.summary        = 'Chatyy row-to-conversation zoom transition'
  s.description    = 'Snapshot overlay on the key window that grows the tapped conversation row into the screen while the native push runs without animation.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'QuartzCore'
end
