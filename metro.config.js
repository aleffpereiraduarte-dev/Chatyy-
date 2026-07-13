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
  // Single-session AR status camera stack — native-only (JSI worklets,
  // Skia GPU canvas, MLKit frame-processor plugin). Stubbed on web so the
  // web bundle resolves; StatusVisionCamera is only mounted on native
  // (StatusCamera guards with Platform.OS !== 'web') so the stubbed hooks
  // are never actually called in the browser.
  'react-native-vision-camera',
  'react-native-vision-camera-face-detector',
  'react-native-worklets-core',
  '@shopify/react-native-skia',
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
  // expo-av was REMOVED in SDK 54+; several files keep defensive
  // `require('expo-av')` fallbacks (never taken on SDK 55). Metro must still
  // resolve it at bundle time — point it at an empty-object stub so the require
  // yields undefined and the try/catch fallbacks behave as if it threw. Without
  // this, enabling React Compiler makes the export fail on "Unable to resolve
  // module expo-av". Applies to ALL platforms.
  if (moduleName === 'expo-av') {
    return {
      filePath: require.resolve('./stubs/expo-av.js'),
      type: 'sourceFile',
    };
  }
  if (moduleName === 'event-target-shim') {
    return context.resolveRequest(context, 'event-target-shim', platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
