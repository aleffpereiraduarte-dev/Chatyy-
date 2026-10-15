require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatEffects'
  s.version        = package['version']
  s.summary        = 'Chatyy native message screen effects'
  s.description    = 'Full-screen Core Animation / CAEmitterLayer overlay (confetti, balloons, love, fireworks, lasers, echo, spotlight, shooting star, celebration, emoji rain).'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'QuartzCore'
end
