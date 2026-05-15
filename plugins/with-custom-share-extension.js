/**
 * Expo config plugin — wire up the Chatyy custom ShareExtension UI + Siri
 * suggestions plumbing during prebuild.
 *
 * Background
 * ----------
 * /ios is gitignored in this repo; the iOS folder is generated fresh by
 * `expo prebuild --clean` on every CI build. The default `expo-share-intent`
 * plugin writes a bare ShareViewController.swift that we replaced with a
 * 1700-line WhatsApp-style multi-select UI (Frequent / Recent sections,
 * Status / Feed shortcuts, background uploads, INSendMessageIntent
 * pre-selection). That custom Swift lives at `/native-ios/share-extension/
 * ShareViewController.swift` so it survives in git; this plugin copies it
 * into the prebuild output AFTER expo-share-intent has run, overwriting
 * the default template.
 *
 * Why a config plugin instead of a build-time bash step:
 *   - Runs in the same prebuild step the rest of the project uses, so any
 *     env that's right for prebuild is right for us too.
 *   - Order of plugins in app.json determines execution order — putting
 *     this AFTER `expo-share-intent` guarantees we win the file race.
 *   - The plugin also patches the main app's Info.plist to declare
 *     `INSendMessageIntent` in NSUserActivityTypes (required for iOS to
 *     surface the Share Sheet "Suggested" avatar row).
 *
 * Files written:
 *   ios/ShareExtension/ShareViewController.swift  ← overwritten with custom
 *   ios/<MainTarget>/Info.plist                   ← NSUserActivityTypes
 */
const { withDangerousMod, withInfoPlist } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SRC_SWIFT = path.join(
  __dirname,
  '..',
  'native-ios',
  'share-extension',
  'ShareViewController.swift'
);
const DEST_REL = path.join('ShareExtension', 'ShareViewController.swift');

const withCustomShareExtensionSwift = (config) =>
  withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const dest = path.join(iosRoot, DEST_REL);
      if (!fs.existsSync(SRC_SWIFT)) {
        console.warn(
          `[with-custom-share-extension] source missing: ${SRC_SWIFT} — leaving expo-share-intent default in place`
        );
        return cfg;
      }
      // The folder is created by expo-share-intent earlier in the
      // prebuild pipeline. If it's not there yet, our plugin ran out of
      // order — emit a clear warning instead of silently no-op'ing.
      if (!fs.existsSync(path.dirname(dest))) {
        console.warn(
          `[with-custom-share-extension] ${path.dirname(
            dest
          )} missing — expo-share-intent did not run before this plugin. Check plugin order in app.json (expo-share-intent must come first).`
        );
        return cfg;
      }
      fs.copyFileSync(SRC_SWIFT, dest);
      console.log(
        `[with-custom-share-extension] wrote custom Swift (${fs
          .statSync(dest)
          .size} bytes) → ${dest}`
      );
      return cfg;
    },
  ]);

const withMainAppIntentTypes = (config) =>
  withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    const existing = Array.isArray(plist.NSUserActivityTypes)
      ? plist.NSUserActivityTypes
      : [];
    // Apple resolves Share Sheet suggestions when the app declares it
    // handles INSendMessageIntent activity types. Without this entry,
    // donations succeed but the system silently drops them for surface
    // purposes — that's why "ações rápidas" stayed empty in TestFlight.
    const required = ['INSendMessageIntent'];
    const merged = Array.from(new Set([...existing, ...required]));
    plist.NSUserActivityTypes = merged;
    return cfg;
  });

module.exports = function withCustomShareExtension(config) {
  config = withMainAppIntentTypes(config);
  config = withCustomShareExtensionSwift(config);
  return config;
};
