const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Fix event-target-shim version conflict between expo (v5) and react-native-webrtc (v6)
// Alias react-native-webrtc → @stream-io/react-native-webrtc
// This makes @telnyx/webrtc SDK work on native (it imports react-native-webrtc internally)
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'react-native-webrtc': require.resolve('@stream-io/react-native-webrtc'),
};

// Native-only modules that explode the web bundle and have no browser use
// (web already has navigator.mediaDevices / RTCPeerConnection built in).
const WEB_STUBS = new Set([
  '@stream-io/react-native-webrtc',
  'react-native-webrtc',
  '@twilio/voice-sdk',
  '@telnyx/webrtc',
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    if (moduleName === 'react-native-gesture-handler') {
      return {
        filePath: require.resolve('./gesture-handler-web-stub.js'),
        type: 'sourceFile',
      };
    }
    if (WEB_STUBS.has(moduleName)) {
      return {
        filePath: require.resolve('./web-stubs/empty-module.js'),
        type: 'sourceFile',
      };
    }
  }
  if (moduleName === 'event-target-shim') {
    return context.resolveRequest(context, 'event-target-shim', platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
