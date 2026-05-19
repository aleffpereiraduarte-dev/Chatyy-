const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// expo-sqlite/web/worker.ts imports `./wa-sqlite/wa-sqlite.wasm` directly;
// Metro doesn't bundle .wasm by default. Treating it as an asset makes Metro
// emit the file and return its URL — wa-sqlite then fetches+instantiates it.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts = [...config.resolver.assetExts, 'wasm'];
}

// Alias react-native-webrtc → @livekit/react-native-webrtc (LiveKit fork,
// drop-in API + bundled patches needed by LiveKit RN SDK). Replaces the
// previous @stream-io fork — both ship the same native module surface but
// only one can be installed at a time.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'react-native-webrtc': require.resolve('@livekit/react-native-webrtc'),
};

// Native-only modules that explode the web bundle and have no browser use
// (web already has navigator.mediaDevices / RTCPeerConnection built in).
const WEB_STUBS = new Set([
  '@livekit/react-native-webrtc',
  '@livekit/react-native',
  'livekit-client',
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
