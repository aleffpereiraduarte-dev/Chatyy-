module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          unstable_transformImportMeta: true,
        },
      ],
    ],
    plugins: [
      // Fixes the "Cannot read property 'optional' of undefined" / optional
      // chaining transform error that react-native-worklets-core's worklet
      // transform trips over on some toolchains. Must come BEFORE the
      // worklets plugin so the worklet AST is already lowered.
      '@babel/plugin-proposal-optional-chaining',
      // react-native-worklets-core MUST be the LAST plugin so it can see the
      // fully-transformed AST and hoist `'worklet'`-marked functions into the
      // VisionCamera JS runtime. Powers useSkiaFrameProcessor + runAsync in
      // the single-session AR camera (StatusCamera.js).
      'react-native-worklets-core/plugin',
    ],
  };
};
