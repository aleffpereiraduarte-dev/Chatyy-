require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoPhotosBackup'
  s.version        = package['version']
  s.summary        = 'Chatyy native photo backup engine'
  s.description    = 'PhotoKit persistent-change scan + durable SQLite queue per account + background URLSession uploads + BGProcessingTask.'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'

  s.frameworks = 'UIKit', 'Photos', 'BackgroundTasks', 'ImageIO', 'CryptoKit', 'Network', 'Security', 'UserNotifications', 'UniformTypeIdentifiers'
  s.libraries = 'sqlite3'
end
