Pod::Spec.new do |s|
  s.name           = 'expo-chat-cache'
  s.version        = '1.0.0'
  s.summary        = 'Native SQLite chat message cache with synchronous read API'
  s.description    = 'Stores chat messages in SQLite + in-memory cache. Exposes a synchronous getCachedMessagesSync so the JS chat screen can populate useState initializer with cached messages on first render — eliminates flicker between mount and async cache load.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.libraries = 'sqlite3'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
