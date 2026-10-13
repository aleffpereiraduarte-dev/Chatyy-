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
  s.dependency 'LiveKitClient', '2.0.18' # [2026-10-07 audio-route] pin: AudioRouter usa customConfigureAudioSessionFunc (API da 2.0.18; depreciada nas novas)

  # [2026-10-09 p2p-ios] P2PCallSessionIOS.swift faz `import LiveKitWebRTC`
  # (libwebrtc que o LiveKitClient 2.0.18 JÁ traz: LiveKitClient.podspec →
  # `spec.dependency("LiveKitWebRTC", "= 125.6422.11")`). Declarado aqui com a
  # MESMA versão exata → o resolvedor do CocoaPods não muda nada (mesmo
  # xcframework, zero binário novo) e o módulo fica importável neste pod.
  # Se algum dia o LiveKitClient subir, ESTA linha tem de subir junto (ver
  # LiveKitClient.podspec da versão nova). O arquivo tem `#if
  # canImport(LiveKitWebRTC)` com stub — sem o módulo, o P2P só desliga.
  s.dependency 'LiveKitWebRTC', '125.6422.11'

  # [2026-05-17 MediaPipe background blur / virtual background]
  # Google open-source MediaPipe (Apache 2). BackgroundProcessor.swift wraps
  # MPPImageSegmenter for live background blur + virtual wallpapers in the
  # call screen. Reflection-loaded so a missing pod doesn't break the
  # module — but adding it here means the symbols are present at runtime
  # by default. Pinned to ~> 0.10 to track current iOS releases.
  #
  # [2026-05-26] This pod statically vendors its OWN copies of
  # GTMSessionFetcher + GoogleToolboxForMac, which collide at link time with
  # the standalone copies pulled by GoogleMLKit/FaceDetection (the Status AR
  # face-filters via react-native-vision-camera-face-detector) →
  # `ld: NNN duplicate symbols`. BOTH features are required, so the duplicate
  # object files are stripped from MediaPipe's static .a in a Podfile
  # post_install injected by the `withMediapipeMlkitDedup` config plugin
  # (plugins/withMediapipeMlkitDedup.js). DO NOT remove this dependency.
  s.dependency 'MediaPipeTasksVision', '~> 0.10'

  # [2026-05-17 screen share — LiveKit] Screen-share frame transmission relies
  # on LiveKitClient's own broadcast helpers (LKSampleHandler, app-group
  # plumbing) which are part of the main `LiveKitClient` pod already declared
  # above. No subspec dependency required — the LK 2.0 podspec bundles
  # ScreenShare-related sources by default. The ChatyyBroadcastExtension
  # target's own Podfile entry (see ios/Podfile) pulls LiveKitClient on the
  # extension side. SampleHandler.swift already extends `LKSampleHandler`.

  # [2026-10-11 noise] RNNoise (BSD-3, vendored v0.1.1) for real ML noise
  # suppression in native calls — RNNoiseAudioProcessor.swift.
  # [2026-10-11 noise-ios] The C lives in its OWN pure-C pod `ChatyyNoise`
  # (ios/ChatyyNS/ChatyyNoise.podspec, zero dependencies, USE_HEADERMAP=NO):
  # compiled inside THIS pod the quote include "stdlib.h" of rnnoise/common.h
  # resolved (case-insensitive header map) to ReactNativeDependencies'
  # folly/portability/Stdlib.h → "'cstdlib' file not found" (CI 38109542058).
  # ChatyyNoise is autolinked via expo-module.config.json apple.podspecPath
  # (array) and imported in Swift with `import ChatyyNoise` (canImport-guarded
  # → pass-through if the pod is ever missing). ExpoCallKit itself is Swift-only.
  s.dependency 'ChatyyNoise'
  s.source_files = ['**/*.swift']
  s.exclude_files = 'ChatyyNS/**/*'

  # [2026-10-07 bgsync] BackgroundTasks → ChatBgSyncAppDelegateSubscriber (BGAppRefreshTask).
  # [2026-10-12 find-my] CoreLocation → FriendLocationAgent (significant-change/visits/ping).
  s.frameworks = 'CallKit', 'PushKit', 'AVFoundation', 'CoreImage', 'CoreVideo', 'Intents', 'BackgroundTasks', 'CoreLocation'
  # [2026-10-07 ios-native] CallLiveActivity.swift — ActivityKit is iOS 16.1+;
  # app deployment target is 16.0, so weak-link it (all uses are #available-gated).
  s.weak_frameworks = 'ActivityKit'
end
