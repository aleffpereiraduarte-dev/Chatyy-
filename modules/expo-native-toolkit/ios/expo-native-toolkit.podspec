Pod::Spec.new do |s|
  s.name           = 'expo-native-toolkit'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS toolkit: HTML/PDF views, audio, image processing, haptics, reachability'
  s.description    = 'Bundled native modules: WKWebView pool for HTML email rendering, PDFKit view, AVAudioEngine recorder/player, Core Image, NWPathMonitor reachability, Core Haptics, SFSpeechRecognizer voice transcription.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  # [2026-10-09 notif-native] 15.1 = ExpoNotifications' floor (dependency below).
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # [2026-10-09 notif-native] ChatNotifActions.swift registers a
  # NotificationCenterManager delegate (inline Reply / Mark as read handled
  # natively with the app killed). Pod already in the app via expo-notifications.
  s.dependency 'ExpoNotifications'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
