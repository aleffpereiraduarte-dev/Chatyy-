require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatComposer'
  s.version        = package['version']
  s.summary        = 'Chatyy native chat composer'
  s.description    = 'UITextView auto-growing composer with mentions, image paste, send/mic morph and in-composer AVAudioRecorder voice notes (hold, slide to cancel, slide up to lock).'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'AVFoundation', 'QuartzCore'
end
