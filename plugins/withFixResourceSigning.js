/**
 * Expo config plugin — patches the generated Podfile with a post_install hook
 * that disables code-signing on CocoaPods resource bundle targets.
 *
 * Why: Since Xcode 14 CocoaPods resource bundles require an explicit
 * development team, and EAS Build doesn't set one on every transitive pod.
 * The build fails with:
 *   "Starting from Xcode 14, resource bundles are signed by default, which
 *    requires setting the development team for each resource bundle target."
 *
 * This plugin makes the Podfile skip signing for bundle products, matching
 * the standard React Native template workaround.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const HOOK_MARKER = '# --- withFixResourceSigning ---';

const HOOK_BODY = `
${HOOK_MARKER}
post_install do |installer|
  installer.pods_project.targets.each do |target|
    if target.respond_to?(:product_type) && target.product_type == 'com.apple.product-type.bundle'
      target.build_configurations.each do |config|
        config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
        config.build_settings['CODE_SIGNING_REQUIRED'] = 'NO'
        config.build_settings['EXPANDED_CODE_SIGN_IDENTITY'] = ''
      end
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
      // Idempotent: only inject once.
      if (contents.includes(HOOK_MARKER)) return cfg;
      // Append at end — the RN template already has a post_install elsewhere,
      // but Podfiles allow multiple post_install blocks and they chain.
      contents += '\n' + HOOK_BODY + '\n';
      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};
