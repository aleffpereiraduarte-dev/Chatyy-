/**
 * Config plugin — adds the ChatyyBroadcastExtension iOS target to the Xcode
 * project on every `expo prebuild`. Without this, the extension's Swift
 * source under ios/ChatyyBroadcastExtension/ sits orphaned and never gets
 * compiled.
 *
 * WHAT IT DOES:
 *   1. Copies the extension source files from ios/ChatyyBroadcastExtension/
 *      into the prebuild output (otherwise they'd be wiped on every prebuild).
 *   2. Adds a new PBXNativeTarget of type appex (com.apple.product-type.app-extension).
 *   3. Sets the bundle id to com.onemundo.mail.broadcast and inherits team
 *      from the main target so EAS signing picks it up automatically.
 *   4. Adds the App Group entitlement (group.com.onemundo.mail) to BOTH the
 *      main app and the extension — they share a sandbox via this group
 *      (same one ShareExtension already uses, no new provisioning entry).
 *   5. Adds ReplayKit.framework to the extension's link phase.
 *
 * RUN: `expo prebuild --clean` to regenerate, then `pod install` in ios/.
 *
 * WARNING: This rewrites project.pbxproj. If a developer manually edited
 * the Xcode project, those edits will be clobbered. Always treat ios/ as
 * generated.
 */

const fs = require('fs');
const path = require('path');
const { withXcodeProject, withEntitlementsPlist, withInfoPlist, withDangerousMod } = require('expo/config-plugins');

const EXT_NAME = 'ChatyyBroadcastExtension';
const EXT_BUNDLE_ID = 'com.onemundo.mail.broadcast';
const APP_GROUP = 'group.com.onemundo.mail';

// Source dir lives at /ios/ChatyyBroadcastExtension/ in the repo. expo
// prebuild wipes /ios/, so we re-copy on every prebuild via a dangerous mod.
const SOURCE_DIR = path.join('ios', EXT_NAME);

function withBroadcastExtensionFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const destDir = path.join(cfg.modRequest.platformProjectRoot, EXT_NAME);
      const srcDir = path.join(projectRoot, SOURCE_DIR);

      if (!fs.existsSync(srcDir)) {
        console.warn(`[with-broadcast-extension] source ${srcDir} missing — skip`);
        return cfg;
      }

      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const files = ['SampleHandler.swift', 'Info.plist', `${EXT_NAME}.entitlements`];
      for (const f of files) {
        const src = path.join(srcDir, f);
        const dst = path.join(destDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      }
      return cfg;
    },
  ]);
}

function withMainAppGroup(config) {
  // Main app needs App Group too so it can read frames the extension wrote.
  return withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });
}

function withBroadcastTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = cfg.modRequest.projectName || 'ChatyyMail';

    // Idempotency — skip if already added
    const existingTarget = project.pbxNativeTargetSection?.();
    if (existingTarget) {
      for (const key of Object.keys(existingTarget)) {
        const t = existingTarget[key];
        if (t && typeof t === 'object' && t.name === EXT_NAME) {
          return cfg;
        }
      }
    }

    const targetUuid = project.generateUuid();
    const groupUuid = project.generateUuid();

    // Create a PBXGroup for the extension's files
    const group = project.addPbxGroup(
      ['SampleHandler.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
      EXT_NAME,
      EXT_NAME,
      '"<group>"'
    );

    // Attach group to root
    const rootGroup = project.getFirstProject()['firstProject']['mainGroup'];
    project.addToPbxGroup(group.uuid, rootGroup);

    // Add the target itself
    const target = project.addTarget(
      EXT_NAME,
      'app_extension',
      EXT_NAME,
      EXT_BUNDLE_ID
    );

    // Add Swift source build phase
    project.addBuildPhase(
      ['SampleHandler.swift'],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid
    );

    // Frameworks: ReplayKit
    project.addBuildPhase(
      ['ReplayKit.framework'],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid
    );

    // Embed the extension into the main app's bundle
    project.addBuildPhase(
      [],
      'PBXCopyFilesBuildPhase',
      'Embed App Extensions',
      project.getFirstTarget().uuid,
      'app_extension'
    );

    // Build settings — point to entitlements + Info.plist
    const xcConfig = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(xcConfig)) {
      const c = xcConfig[key];
      if (c.buildSettings && c.buildSettings.PRODUCT_NAME === `"${EXT_NAME}"`) {
        c.buildSettings.INFOPLIST_FILE = `"${EXT_NAME}/Info.plist"`;
        c.buildSettings.CODE_SIGN_ENTITLEMENTS = `"${EXT_NAME}/${EXT_NAME}.entitlements"`;
        c.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '"15.0"';
        c.buildSettings.SWIFT_VERSION = '5.0';
        c.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${EXT_BUNDLE_ID}"`;
        c.buildSettings.CODE_SIGN_STYLE = '"Automatic"';
        c.buildSettings.LD_RUNPATH_SEARCH_PATHS =
          '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
      }
    }

    return cfg;
  });
}

module.exports = function withBroadcastExtension(config) {
  config = withBroadcastExtensionFiles(config);
  config = withMainAppGroup(config);
  config = withBroadcastTarget(config);
  return config;
};
