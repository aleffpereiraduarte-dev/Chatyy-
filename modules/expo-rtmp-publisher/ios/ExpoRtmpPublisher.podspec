Pod::Spec.new do |s|
  s.name           = 'ExpoRtmpPublisher'
  s.version        = '0.1.0'
  s.summary        = 'Native RTMP/RTMPS publisher for Expo (camera + mic → Cloudflare Stream Live).'
  s.description    = 'Publishes camera + microphone capture to an RTMP/RTMPS ingest endpoint using HaishinKit. Designed for Cloudflare Stream Live but works with any RTMP ingest (Twitch, YouTube Live, custom NGINX-RTMP, etc.).'
  s.author         = 'Chatyy'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ---------------------------------------------------------------------------
  # TODO: add HaishinKit when wiring up the real implementation. HaishinKit is
  # distributed via Swift Package Manager and via CocoaPods. With Expo modules
  # we typically pin the Pod version here:
  #
  #   s.dependency 'HaishinKit', '~> 1.9'
  #
  # Alternative SwiftPM integration: declare it in the host app's Podfile or
  # via `:dependencies` in the EAS build config.
  # ---------------------------------------------------------------------------

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
