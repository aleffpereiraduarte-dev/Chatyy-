Pod::Spec.new do |s|
  s.name           = 'expo-native-toolkit'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS toolkit: HTML/PDF views, audio, image processing, haptics, reachability'
  s.description    = 'Bundled native modules: WKWebView pool for HTML email rendering, PDFKit view, AVAudioEngine recorder/player, Core Image, NWPathMonitor reachability, Core Haptics, SFSpeechRecognizer voice transcription.'
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
