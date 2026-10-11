# [2026-10-11 noise-ios] RNNoise (Xiph/Mozilla, BSD-3, vendored v0.1.1) as a
# STANDALONE pure-C pod, consumed by ExpoCallKit (RNNoiseAudioProcessor.swift →
# `import ChatyyNoise`).
#
# Why a separate pod: compiled inside ExpoCallKit (which depends on
# ExpoModulesCore → React → ReactNativeDependencies) the quote include
# `#include "stdlib.h"` of rnnoise/common.h resolved — through Xcode's header
# maps, which are case-insensitive — to
# Pods/ReactNativeDependencies/Headers/folly/portability/Stdlib.h, a C++ header
# ("'cstdlib' file not found", CI run 38109542058). Defence in depth:
#   1. this pod has ZERO dependencies (no React/folly search paths, no
#      transitive module maps);
#   2. USE_HEADERMAP=NO → no Xcode header maps at all for this target (the
#      vendored quote includes all resolve relative to the including file);
#   3. the 3 quote-includes of libc headers in the vendored code were changed
#      to <...> (rnnoise/common.h, rnnoise/pitch.c).
#
# Pod name ≠ directory on purpose: the directory is shared with Android
# (android/CMakeLists.txt → ../ios/ChatyyNS) and the module must not have the
# same name as the C type `ChatyyNS` declared in chatyy_ns.h.
#
# Autolinked by expo-modules-autolinking through
# modules/expo-callkit/expo-module.config.json → apple.podspecPath (array), so
# `pod 'ChatyyNoise', :path => '../modules/expo-callkit/ios/ChatyyNS'` is added
# to the app target automatically on every prebuild — no Podfile plugin.
#
# Build shape: ONE translation unit (chatyy_ns.c #includes rnnoise/*.c, see the
# comment there) + ONE public plain-C header (chatyy_ns.h). rnnoise/** is
# preserve_paths only (compiling those files separately = duplicate symbols).

Pod::Spec.new do |s|
  s.name           = 'ChatyyNoise'
  s.version        = '0.1.1'
  s.summary        = 'RNNoise noise suppressor (pure C) for Chatyy native calls'
  s.description    = 'Vendored RNNoise v0.1.1 (BSD-3) behind a tiny C API (chatyy_ns.h), shared with the Android JNI build.'
  s.license        = { :type => 'BSD-3-Clause', :file => 'rnnoise/COPYING' }
  s.author         = 'OneMundo'
  s.homepage       = 'https://chatyy.com.br'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.requires_arc   = false

  s.source_files        = 'chatyy_ns.h', 'chatyy_ns.c'
  s.public_header_files = 'chatyy_ns.h'
  s.preserve_paths      = 'rnnoise/**/*'

  s.pod_target_xcconfig = {
    # Swift (ExpoCallKit) imports this as a clang module.
    'DEFINES_MODULE' => 'YES',
    # No header maps → no case-insensitive hit on another pod's Stdlib.h/Math.h.
    'USE_HEADERMAP' => 'NO',
    'GCC_C_LANGUAGE_STANDARD' => 'gnu11',
    # Vendored code is not ours to lint; it is optimized even in Debug because
    # it runs on the real-time audio thread every 10 ms.
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES',
    'GCC_OPTIMIZATION_LEVEL' => '3',
    'OTHER_CFLAGS' => '$(inherited) -w',
  }
end
