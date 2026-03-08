require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoCallKit'
  s.version        = package['version']
  s.summary        = 'Expo module for CallKit and VoIP Push'
  s.description    = 'Native CallKit integration for incoming calls with VoIP Push support'
  s.author         = 'OneMundo'
  s.homepage       = 'https://onemundo.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation'
end
