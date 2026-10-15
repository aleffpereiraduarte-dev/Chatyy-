require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatPrivacy'
  s.version        = package['version']
  s.summary        = 'Chatyy advanced chat privacy shield (screen recording / mirroring)'
  s.description    = 'Shows an opaque UIWindow above everything while UIScreen.isCaptured is true and a protected screen holds the shield; emits capture-state events to JS.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit'
end
