// expo-live-native config plugin.
//
// v1 is a no-op — the native module is autolinked via package.json (file:
// dep) + expo-module.config.json. We register an empty plugin only so the
// host app's `app.json` can list `./modules/expo-live-native` in its
// plugins[] array, which keeps the module surface centralized with the
// other custom modules.
//
// When we need to inject native code (e.g. additional <activity> entries in
// the merged AndroidManifest, or extra Info.plist keys for the iOS half),
// swap the body for a real `withDangerousMod` or `withAndroidManifest`
// modifier here. Until then the AndroidManifest in
// `modules/expo-live-native/android/src/main/AndroidManifest.xml` already
// covers everything via manifest merge.

module.exports = function withExpoLiveNative(config) {
  return config;
};
