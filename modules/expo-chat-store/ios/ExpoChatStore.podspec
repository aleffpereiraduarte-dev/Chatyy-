require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoChatStore'
  s.version        = package['version']
  s.summary        = 'Chatyy native local chat store'
  s.description    = 'System SQLite (libsqlite3) store, one database file per account, read directly by the native chat lists (no JS bridge on the read path).'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.libraries = 'sqlite3'
  s.frameworks = 'CryptoKit'

  # ExpoChatMessageList faz `import ExpoChatStore` (ChatyyStoreDB é public).
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.swift'
end
