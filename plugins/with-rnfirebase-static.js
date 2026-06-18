// with-rnfirebase-static.js — make ONLY the Firebase iOS pods build as static
// frameworks, WITHOUT flipping the whole project to `use_frameworks! :static`.
//
// Why: @react-native-firebase needs the Firebase iOS SDK linked as a static
// framework. The "official" Expo way is expo-build-properties
// `ios.useFrameworks: "static"`, but on RN 0.83 / Expo SDK 55 that global flag
// breaks the build (React-Core-prebuilt modulemap is never generated, and it
// cascades into RNScreens / expo-router / vision-camera / LiveKit). Setting the
// `$RNFirebaseAsStaticFramework = true` Podfile global scopes static linkage to
// Firebase pods only, leaving every other pod exactly as it builds today. This
// is the RNFirebase-documented escape hatch for apps that can't use global
// use_frameworks. See rnfirebase.io iOS install + invertase/react-native-firebase#8657.

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const LINE = '$RNFirebaseAsStaticFramework = true';

module.exports = function withRNFirebaseStatic(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      try {
        let contents = fs.readFileSync(podfile, 'utf8');
        if (!contents.includes('$RNFirebaseAsStaticFramework')) {
          contents = `${LINE}\n${contents}`;
          fs.writeFileSync(podfile, contents);
        }
      } catch (e) {
        // If the Podfile isn't there yet (shouldn't happen during prebuild),
        // fail loud in logs but don't crash config resolution.
        // eslint-disable-next-line no-console
        console.warn('[with-rnfirebase-static] could not patch Podfile:', e?.message);
      }
      return cfg;
    },
  ]);
};
