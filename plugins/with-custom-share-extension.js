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
const { withDangerousMod, withInfoPlist, withFinalizedMod } = require('@expo/config-plugins');
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

// [2026-10-09 notif-native] Share-sheet SUGGESTIONS (row of recent chats on
// top of the iOS share sheet). Two gaps made them never show / never route:
//   1. The extension's Info.plist lacked NSExtensionAttributes.IntentsSupported
//      = [INSendMessageIntent] → iOS never offers our donated conversations.
//   2. The ShareViewController that actually ships is expo-share-intent's
//      template (it is (re)written by expo-share-intent's XCODEPROJ mod, which
//      runs AFTER every dangerous mod — so withCustomShareExtensionSwift above
//      never wins on a clean prebuild). We therefore inject a tiny capture into
//      WHATEVER VC is on disk: the tapped suggestion's conversationIdentifier /
//      recipient handle is parked in the App Group ("chatyy.share_target") and
//      /share-receive preselects that chat (ExpoChatyyIntents.consumeShareTarget).
// Runs as a FINALIZED mod (after xcodeproj) so it sees the final files.
const SHARE_EXT_DIR = 'ShareExtension';
const SHARE_TARGET_MARK = '// [chatyy share-target capture v1]';
const SHARE_TARGET_EXT = `

${SHARE_TARGET_MARK} — injected by plugins/with-custom-share-extension.js
extension ShareViewController {
  func chatyyRecordShareTarget() {
    guard #available(iOS 14.0, *),
          let intent = extensionContext?.intent as? INSendMessageIntent else { return }
    let conv = intent.conversationIdentifier ?? ""
    let handle = intent.recipients?.first?.personHandle?.value ?? ""
    if conv.isEmpty && handle.isEmpty { return }
    guard let ud = UserDefaults(suiteName: "group.com.onemundo.mail") else { return }
    ud.set(["conv": conv, "handle": handle, "at": Date().timeIntervalSince1970], forKey: "chatyy.share_target")
  }
}
`;

const withShareSuggestionsSupport = (config) =>
  withFinalizedMod(config, [
    'ios',
    async (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, SHARE_EXT_DIR);
      // 1) Info.plist → IntentsSupported
      try {
        const plistPath = path.join(dir, 'ShareExtension-Info.plist');
        if (fs.existsSync(plistPath)) {
          const plist = require('@expo/plist').default || require('@expo/plist');
          const obj = plist.parse(fs.readFileSync(plistPath, 'utf8'));
          obj.NSExtension = obj.NSExtension || {};
          const attrs = obj.NSExtension.NSExtensionAttributes || {};
          const cur = Array.isArray(attrs.IntentsSupported) ? attrs.IntentsSupported : [];
          if (!cur.includes('INSendMessageIntent')) {
            attrs.IntentsSupported = [...cur, 'INSendMessageIntent'];
            obj.NSExtension.NSExtensionAttributes = attrs;
            fs.writeFileSync(plistPath, plist.build(obj));
          }
          console.log('[with-custom-share-extension] ShareExtension IntentsSupported=[INSendMessageIntent]');
        } else {
          console.warn(`[with-custom-share-extension] ${plistPath} missing — share suggestions NOT enabled`);
        }
      } catch (e) {
        console.warn('[with-custom-share-extension] IntentsSupported patch failed:', e?.message || e);
      }
      // 2) ShareViewController → capture the tapped suggestion
      try {
        const vcPath = path.join(dir, 'ShareViewController.swift');
        if (fs.existsSync(vcPath)) {
          let src = fs.readFileSync(vcPath, 'utf8');
          if (!src.includes(SHARE_TARGET_MARK)) {
            const anchor = 'super.viewDidLoad()';
            const i = src.indexOf(anchor);
            if (i < 0 || !/class ShareViewController\b/.test(src)) {
              console.warn('[with-custom-share-extension] viewDidLoad anchor not found — share-target capture skipped');
            } else {
              src = src.slice(0, i + anchor.length) + '\n    chatyyRecordShareTarget()' + src.slice(i + anchor.length);
              if (!/^import Intents\b/m.test(src)) {
                src = src.replace(/^import UIKit\b.*$/m, (m) => `${m}\nimport Intents`);
                if (!/^import Intents\b/m.test(src)) src = `import Intents\n${src}`;
              }
              src += SHARE_TARGET_EXT;
              fs.writeFileSync(vcPath, src);
              console.log('[with-custom-share-extension] share-target capture injected');
            }
          }
        }
      } catch (e) {
        console.warn('[with-custom-share-extension] share-target capture failed:', e?.message || e);
      }
      return cfg;
    },
  ]);

module.exports = function withCustomShareExtension(config) {
  config = withMainAppIntentTypes(config);
  config = withCustomShareExtensionSwift(config);
  config = withShareSuggestionsSupport(config);
  return config;
};
