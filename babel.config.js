// [2026-10-06 keyboard-controller] DOIS motores de worklet convivem no app:
//   • react-native-worklets (Software Mansion, Reanimated 4 / keyboard-controller)
//   • react-native-worklets-core (Margelo, frame processors do VisionCamera +
//     Skia na câmera AR do Status, Android)
// Os dois plugins Babel reescrevem a MESMA diretiva 'worklet' em formatos
// diferentes — quem processa a função primeiro "ganha", e o runtime errado
// rejeita/quebra o worklet ("not a valid worklet", jitsi-meet#17933). Então
// cada plugin é ESCOPADO por arquivo via `overrides`:
//   - worklets-core/plugin SÓ na pilha VisionCamera (app + node_modules)
//   - worklets/plugin (Reanimated 4) em TODO o resto, e por último
// O auto-add do worklets plugin pelo babel-preset-expo é desligado
// (`worklets:false` + `reanimated:false`) para ele não rodar também nos arquivos da câmera.
const VISION_CAMERA_STACK = [
  /[\\/]node_modules[\\/]react-native-vision-camera[\\/]/,
  /[\\/]node_modules[\\/]react-native-vision-camera-face-detector[\\/]/,
  /[\\/]node_modules[\\/]react-native-worklets-core[\\/]/,
  /[\\/]components[\\/]status[\\/](StatusVisionCamera|faceDetectorShim)\.js$/,
];
const isVisionCameraFile = (filename) =>
  !!filename && VISION_CAMERA_STACK.some((re) => re.test(filename));

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          unstable_transformImportMeta: true,
          // Added manually (scoped) in `overrides` below. BOTH flags are
          // needed: with only `worklets:false` the preset falls back to
          // auto-adding `react-native-reanimated/plugin` (same transform).
          worklets: false,
          reanimated: false,
        },
      ],
    ],
    plugins: [
      // Fixes the "Cannot read property 'optional' of undefined" / optional
      // chaining transform error that react-native-worklets-core's worklet
      // transform trips over on some toolchains. Must come BEFORE the
      // worklets plugins so the worklet AST is already lowered.
      '@babel/plugin-proposal-optional-chaining',
    ],
    overrides: [
      {
        // VisionCamera frame processors (useSkiaFrameProcessor + runAsync in
        // StatusVisionCamera.js) run on the worklets-core runtime.
        test: isVisionCameraFile,
        plugins: ['react-native-worklets-core/plugin'],
      },
      {
        // Reanimated 4 / react-native-keyboard-controller. Must be the LAST
        // plugin applied to a file (Reanimated 4 docs).
        exclude: isVisionCameraFile,
        plugins: ['react-native-worklets/plugin'],
      },
    ],
    // Strip console.* from PRODUCTION bundles only (OTA / store builds set
    // BABEL_ENV/NODE_ENV=production). Dev keeps all logs. console.error and
    // console.warn are preserved so genuine failures still surface in prod.
    // ~1,098 console.* calls across the app are removed at build time — less
    // JS shipped, no runtime log overhead on device.
    env: {
      production: {
        plugins: [
          ['transform-remove-console', { exclude: ['error', 'warn'] }],
        ],
      },
    },
  };
};
