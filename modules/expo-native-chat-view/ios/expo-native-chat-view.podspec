Pod::Spec.new do |s|
  s.name           = 'expo-native-chat-view'
  s.version        = '1.0.0'
  s.summary        = 'Native UICollectionView chat view with WhatsApp-grade rendering'
  s.description    = 'Expo View Manager wrapping a native UICollectionView with DataSourcePrefetching. Reads messages directly from the expo-chat-cache SQLite store on the same thread, so the first frame always has bubbles painted. No JS bridge for scroll, no flicker.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.libraries = 'sqlite3'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
