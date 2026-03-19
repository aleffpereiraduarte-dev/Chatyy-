Pod::Spec.new do |s|
  s.name           = 'expo-background-upload'
  s.version        = '1.0.0'
  s.summary        = 'Native background photo upload using PHCachingImageManager + NSURLSession'
  s.description    = 'Upload photos directly to S3 from iOS, continues even when app is closed'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Photos', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
