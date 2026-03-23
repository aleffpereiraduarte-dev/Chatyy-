const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Fix event-target-shim version conflict between expo (v5) and react-native-webrtc (v6)
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Stub out react-native-gesture-handler on web to prevent TDZ crash
  if (platform === 'web' && moduleName === 'react-native-gesture-handler') {
    return {
      filePath: require.resolve('./gesture-handler-web-stub.js'),
      type: 'sourceFile',
    };
  }
  if (moduleName === 'event-target-shim') {
    return context.resolveRequest(context, 'event-target-shim', platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
