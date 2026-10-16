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
  // 'livekit-client' NÃO é stubbado — é o SDK WEB do LiveKit (JS puro, usa o
  // WebRTC nativo do navegador). Stubbá-lo fazia o `new Room()` do pstnCall.js
  // jogar "[web-stub] native-only module was called on web" ao ligar pela web
  // (o número até discava via Vonage, mas o app não entrava na sala de áudio).
  // Só os wrappers NATIVOS de WebRTC abaixo ficam stubbados na web.
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

// [perf 2026-10-06] `expo-symbols` reaches the bundle ONLY through expo-router's
// NativeTabs (withLayoutContext → NativeTabTrigger → materialIconConverter), which
// this app never renders. On Android it statically requires the 7 Material
// Symbols weights from @expo-google-fonts/material-symbols (~6.5MB of TTF assets
// in every APK / first OTA) plus the expo-symbols JS. Stub it on native; web is
// untouched. If NativeTabs are ever adopted, delete this block.
// [2026-10-09 lighter-app] `hls.js` (~545 KB) só é importado por
// app/live-viewer.web.js, mas o require.context do expo-router empacota TODOS
// os arquivos de app/ (inclusive *.web.js) no bundle nativo. No nativo essa
// rota nunca é montada (usa app/live-viewer.js) → stub no Android/iOS.
const NATIVE_STUBS = new Set(['expo-symbols', 'hls.js']);
const LIVEKIT_CLIENT_UMD = require('path').join(__dirname, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((platform === 'android' || platform === 'ios') && NATIVE_STUBS.has(moduleName)) {
    return { filePath: require.resolve('./web-stubs/empty-module.js'), type: 'sourceFile' };
  }
  // [2026-10-09 lighter-app] react-native-qrcode-svg → react-native-svg/css
  // (LocalSvg p/ prop `logoSVG`, nunca usada no app) puxava css-tree/css-select/
  // domutils/entities (~240 KB). Só p/ quem importa de dentro da lib do QR.
  if (moduleName === 'react-native-svg/css' && /[\\/]react-native-qrcode-svg[\\/]/.test(context.originModulePath || '')) {
    return { filePath: require.resolve('./stubs/svg-css-noop.js'), type: 'sourceFile' };
  }
  // [2026-10-15 boot-size] livekit-client entrava DUAS vezes no bundle nativo
  // (~0.53 MB a mais): `require('livekit-client')` (app/lkLoader, @livekit/react-native
  // commonjs) resolvia a condição "require" → dist/livekit-client.umd.js, e o
  // `import` do @livekit/components-react (.mjs) a condição "import" →
  // dist/livekit-client.esm.mjs. Além do peso, eram 2 instâncias do SDK (Room,
  // loggers, instanceof) na mesma ligação. Nativo: todos usam o UMD (o que o app
  // e o @livekit/react-native já usam hoje). Web segue com a resolução padrão.
  if ((platform === 'android' || platform === 'ios') && moduleName === 'livekit-client') {
    return { filePath: LIVEKIT_CLIENT_UMD, type: 'sourceFile' };
  }
  // [2026-10-16 wave13a bundle-diet] Nativo: o index do @livekit/react-native
  // re-exporta hooks/<LiveKitRoom> do @livekit/components-react (~212 KB) que o
  // app NUNCA usa (só registerGlobals/AudioSession/VideoView/E2EE). Stub com
  // contextos reais + funções que lançam erro claro se chamadas. Escopo: só
  // quem importa de dentro do @livekit/react-native. Para usar um hook do
  // components-react no nativo, apague este bloco.
  if ((platform === 'android' || platform === 'ios') && moduleName === '@livekit/components-react'
      && /[\\/]node_modules[\\/]@livekit[\\/]react-native[\\/]/.test(context.originModulePath || '')) {
    return { filePath: require.resolve('./stubs/livekit-components-react-native.js'), type: 'sourceFile' };
  }
  // [2026-10-16 wave13a bundle-diet] Nativo: 'web-streams-polyfill' (~63 KB) era
  // uma 2ª cópia do que o prelude do Expo (expo/virtual/streams.js) já instala
  // em globalThis. O shim reexporta as classes globais.
  if ((platform === 'android' || platform === 'ios') && moduleName === 'web-streams-polyfill') {
    return { filePath: require.resolve('./stubs/web-streams-native.js'), type: 'sourceFile' };
  }
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
