/**
 * Expo config plugin — force manual code-signing on both the main app target
 * and the ShareExtension target, with specific provisioning profiles.
 *
 * Why: this build server (Mac 207) runs headlessly with no Apple ID logged
 * into Xcode, so automatic signing fails with:
 *   "No Accounts: Add a new account in Accounts settings"
 * Manual signing sidesteps the need for an Apple ID by pointing directly at
 * pre-installed .mobileprovision files in ~/Library/MobileDevice/Provisioning
 * Profiles/. The profiles were created ahead of time via the ASC API.
 *
 * Both targets need it because both must be archived for App Store submission
 * (ShareExtension ships bundled inside the main .ipa).
 */
const { withXcodeProject } = require('@expo/config-plugins');

// Profiles baked at Mac-provision time. Keyed by the target name as it appears
// in project.pbxproj's PBXNativeTarget section.
const SIGNING = {
  // Main app (Chatyy) — existing "OneMundoMail AppStore auto" profile
  Chatyy: {
    profile: '6a5fe63e-8838-4eee-9f70-3482a93077eb',
  },
  // ShareExtension — created via ASC API (see build dev notes)
  ShareExtension: {
    profile: '528ffc63-505c-479c-87d8-9871be7db142',
  },
};

const TEAM_ID = 'XN9XN27QCE';
const SIGN_IDENTITY = 'Apple Distribution';

module.exports = function withManualIosSigning(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const configs = proj.pbxXCBuildConfigurationSection();

    for (const key in configs) {
      const bc = configs[key];
      if (!bc || !bc.buildSettings) continue;
      const settings = bc.buildSettings;
      // Match by PRODUCT_NAME (quoted or bare) — cheapest + most stable key.
      // `name` on the build config is Debug/Release, not the target.
      const productName = (settings.PRODUCT_NAME || '').replace(/"/g, '');
      const hit = SIGNING[productName];
      if (!hit) continue;
      settings.CODE_SIGN_STYLE = 'Manual';
      settings.DEVELOPMENT_TEAM = TEAM_ID;
      settings['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = `"${SIGN_IDENTITY}"`;
      settings.CODE_SIGN_IDENTITY = `"${SIGN_IDENTITY}"`;
      settings.PROVISIONING_PROFILE_SPECIFIER = `"${hit.profile}"`;
      settings.PROVISIONING_PROFILE = `"${hit.profile}"`;
    }
    return cfg;
  });
};
