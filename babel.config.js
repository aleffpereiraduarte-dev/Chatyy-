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
    // react-native-worklets-core/plugin transforms the `'worklet'`-directive
    // functions used by Vision Camera v4 frame processors (useSkiaFrameProcessor
    // + the face-detector worklet). This project does NOT use react-native-
    // reanimated, so the worklets-core plugin is what compiles worklets here.
    // MUST stay last in the plugin list (worklets requirement).
    plugins: [
      'react-native-worklets-core/plugin',
    ],
  };
};
