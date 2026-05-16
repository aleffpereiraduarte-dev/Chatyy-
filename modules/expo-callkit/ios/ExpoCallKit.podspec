require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoCallKit'
  s.version        = package['version']
  s.summary        = 'Expo module for CallKit and VoIP Push'
  s.description    = 'Native CallKit integration for incoming calls with VoIP Push support'
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # [stage 2 native LiveKit pre-connect, 2026-05-15]
  # NativeCallRoom.swift does `import LiveKit` from the LiveKitClient pod so
  # the iOS native side can connect to LiveKit before the RN bundle is up.
  # Pinned to ~> 2.0 to match the JS livekit-client ^2.19 and to share the
  # SDK with ChatyyBroadcastExtension (which has its own pod entry).
  # [Day 2 native call screen, 2026-05-16] Re-added — CallViewController owns
  # its own Room for the SwiftUI native call UI. API verified against
  # client-sdk-swift main (LocalParticipant.setMicrophone(enabled:), Room
  # init with delegate param, @objc optional RoomDelegate methods).
  s.dependency 'LiveKitClient', '~> 2.0'

  s.source_files = '**/*.swift'

  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation'
end
