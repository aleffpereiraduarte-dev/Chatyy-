Pod::Spec.new do |s|
  s.name           = 'expo-chat-backup'
  s.version        = '1.0.0'
  s.summary        = 'Encrypted SQLite chat snapshot backup to iCloud Drive'
  s.description    = 'Encrypts the chatyy.db SQLite file with PBKDF2 + AES-256-GCM and uploads to the user\'s iCloud Drive ubiquity container. End-to-end encrypted — Chatyy servers never see the data or key.'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # CommonCrypto, CryptoKit, CloudKit and FileManager are all part of
  # the iOS frameworks so no external pods are required. SQLite is
  # already linked by the host app via expo-sqlite, but we only need
  # the raw .db file (not the SQLite C API) for the backup path, and
  # for the post-restore sanity-check we link against libsqlite3.tbd
  # which iOS provides as a system dylib.
  s.libraries = 'sqlite3'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
