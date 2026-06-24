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
        let changed = false;
        // (1) RNFirebase static-framework global — harmless without use_frameworks,
        //     kept in case frameworks are ever re-enabled.
        if (!contents.includes('$RNFirebaseAsStaticFramework')) {
          contents = `${LINE}\n${contents}`;
          changed = true;
        }
        // (2) CRITICAL FIX (iOS build broke 2026-06-24): FirebaseAuth is a Swift pod
        //     that depends on non-modular pods (GoogleUtilities, FirebaseAuthInterop,
        //     FirebaseAppCheckInterop, RecaptchaInterop). With static libraries (we do
        //     NOT use use_frameworks! on RN0.83 — it cascades into breaking
        //     RNScreens/expo-router/vision-camera/LiveKit), Swift can't import them
        //     unless module maps exist. `use_modular_headers!` emits those maps WITHOUT
        //     changing linkage (static libs stay static libs → no cascade). This is the
        //     error's own recommendation and the standard RN-Firebase-without-frameworks fix.
        if (!contents.includes('use_modular_headers!')) {
          const platformRe = /(\nplatform :ios[^\n]*\n)/;
          if (platformRe.test(contents)) {
            contents = contents.replace(platformRe, `$1use_modular_headers!\n`);
          } else {
            contents = `use_modular_headers!\n${contents}`;
          }
          changed = true;
        }
        if (changed) {
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
