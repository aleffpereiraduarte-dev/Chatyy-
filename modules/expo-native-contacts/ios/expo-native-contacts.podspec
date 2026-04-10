Pod::Spec.new do |s|
  s.name           = 'expo-native-contacts'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS contacts reader using CNContactStore'
  s.description    = 'High-performance native module for reading device contacts via Apple Contacts framework. Returns names, emails, and phone numbers for matching with Chatyy users.'
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
