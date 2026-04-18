/**
 * Expo config plugin — patches the generated Podfile so Xcode doesn't require
 * a dev team on CocoaPods resource-bundle targets.
 *
 * Why: Since Xcode 14 resource bundles are signed by default, requiring a
 * development team for each transitive bundle target. We don't set one, so
 * every build fails on those bundles.
 *
 * How: CocoaPods only allows ONE `post_install` hook per Podfile. The React
 * Native template already emits one inside the `target` block. We INJECT our
 * signing-fix into that existing hook (right before its closing `end`) instead
 * of appending a second top-level hook — which used to produce:
 *   "[!] Invalid Podfile: Specifying multiple post_install hooks is unsupported."
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const HOOK_MARKER = '# --- withFixResourceSigning (merged) ---';

// Code to inject — note it assumes `installer` is already in scope (it is,
// since we insert inside the existing `post_install do |installer|` block).
const INJECT_BODY = `
    ${HOOK_MARKER}
    installer.pods_project.targets.each do |target|
      if target.respond_to?(:product_type) && target.product_type == 'com.apple.product-type.bundle'
        target.build_configurations.each do |config|
          config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
          config.build_settings['CODE_SIGNING_REQUIRED'] = 'NO'
          config.build_settings['EXPANDED_CODE_SIGN_IDENTITY'] = ''
        end
      end
    end
`;

module.exports = function withFixResourceSigning(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;
      let contents = fs.readFileSync(podfilePath, 'utf8');
      if (contents.includes(HOOK_MARKER)) return cfg;
      // Drop any leftover standalone block from the previous (buggy) version
      // of this plugin so we don't end up with two hooks again.
      contents = contents.replace(
        /\n# --- withFixResourceSigning ---\s*\npost_install do \|installer\|[\s\S]*?^end\s*$/m,
        ''
      );
      // Inject our logic inside the RN template's post_install block, right
      // before its closing `end`. Match the specific call signature so we
      // don't target the wrong `end`.
      const rnPostInstallRe = /(post_install do \|installer\|\s*\n\s*react_native_post_install\([\s\S]*?\)\s*\n)(\s*end)/;
      const m = contents.match(rnPostInstallRe);
      if (m) {
        contents = contents.replace(rnPostInstallRe, `$1${INJECT_BODY}$2`);
      } else {
        // Fallback: no RN-template post_install — we're alone, safe to append.
        contents += `\npost_install do |installer|${INJECT_BODY}end\n`;
      }
      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};
