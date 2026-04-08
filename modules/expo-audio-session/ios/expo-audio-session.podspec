Pod::Spec.new do |s|
  s.name           = 'expo-audio-session'
  s.version        = '1.0.0'
  s.summary        = 'Native AVAudioSession control for VoIP calls'
  s.description    = 'Properly manages AVAudioSession category/mode/options across the call lifecycle. Ensures Spotify/Music resume playback after hangup via notifyOthersOnDeactivation.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
