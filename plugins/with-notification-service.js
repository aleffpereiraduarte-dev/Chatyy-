/**
 * Config plugin — adds the ChatyyNotificationService iOS target (a UNNotificationServiceExtension)
 * to the Xcode project on every `expo prebuild`. Without this, the
 * extension's Swift source under ios/ChatyyNotificationService/ sits
 * orphaned and never compiles — and `mutable-content: 1` pushes never
 * render rich attachments / inline reply chips / decrypted bodies.
 *
 * Modeled after with-broadcast-extension.js (same author / pattern).
 *
 * WHAT IT DOES:
 *   1. EMBEDS the extension source (NotificationService.swift, Info.plist,
 *      entitlements) as template strings below. On every prebuild,
 *      withDangerousMod writes them to disk at
 *      `${platformProjectRoot}/ChatyyNotificationService/`. Survives
 *      `expo prebuild --clean`.
 *   2. Adds a new PBXNativeTarget (app extension type).
 *   3. Sets bundle id `com.onemundo.mail.notificationservice`, inherits
 *      team from the main target so EAS signing picks it up.
 *   4. Adds the App Group entitlement so the extension can read the
 *      shared E2E key + auth blob written by the main app + ShareExtension.
 *   5. Links UserNotifications.framework.
 *
 * IF YOU EDIT THE SOURCE: update BOTH the canonical copy under
 * ios/ChatyyNotificationService/ AND the embedded strings below. The
 * embedded version is what compiles; the canonical copy is reference.
 */

const fs = require('fs');
const path = require('path');
const { withXcodeProject, withEntitlementsPlist, withDangerousMod } = require('expo/config-plugins');

const EXT_NAME = 'ChatyyNotificationService';
const EXT_BUNDLE_ID = 'com.onemundo.mail.notificationservice';
const APP_GROUP = 'group.com.onemundo.mail';

// =====================================================================
// EMBEDDED SOURCE FILES — keep in sync with ios/ChatyyNotificationService/
// =====================================================================

const ENTITLEMENTS_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${APP_GROUP}</string>
\t</array>
</dict>
</plist>
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>$(DEVELOPMENT_LANGUAGE)</string>
\t<key>CFBundleDisplayName</key>
\t<string>Chatyy Notification Service</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>$(PRODUCT_NAME)</string>
\t<key>CFBundlePackageType</key>
\t<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
\t<key>CFBundleShortVersionString</key>
\t<string>1.0</string>
\t<key>CFBundleVersion</key>
\t<string>1</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.usernotifications.service</string>
\t\t<key>NSExtensionPrincipalClass</key>
\t\t<string>$(PRODUCT_MODULE_NAME).NotificationService</string>
\t</dict>
</dict>
</plist>
`;

// Read the canonical Swift file from disk so we don't have to maintain a
// massive embedded template string. If the canonical copy disappears (e.g.
// repo was pruned), the plugin falls back to a no-op stub that just
// returns the request unchanged — better than failing the build.
function readCanonicalSwift(projectRoot) {
  try {
    const p = path.join(projectRoot, 'ios', EXT_NAME, 'NotificationService.swift');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch {}
  // Stub fallback — keeps build green even if canonical copy was deleted.
  return `import UserNotifications
class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        contentHandler(request.content)
    }
}
`;
}

// =====================================================================
// MODS
// =====================================================================

function withNotificationServiceFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const destDir = path.join(cfg.modRequest.platformProjectRoot, EXT_NAME);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      const swift = readCanonicalSwift(cfg.modRequest.projectRoot);
      const files = {
        'NotificationService.swift': swift,
        'Info.plist': INFO_PLIST,
        [`${EXT_NAME}.entitlements`]: ENTITLEMENTS_PLIST,
      };
      for (const [fileName, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(destDir, fileName), content, 'utf8');
      }
      return cfg;
    },
  ]);
}

function withMainAppGroup(config) {
  // Main app needs the App Group too so the NSE can read the e2e key the
  // main app wrote into shared UserDefaults. (Already added by the
  // broadcast plugin — this is idempotent.)
  return withEntitlementsPlist(config, (cfg) => {
    const groups = cfg.modResults['com.apple.security.application-groups'] || [];
    if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
    cfg.modResults['com.apple.security.application-groups'] = groups;
    return cfg;
  });
}

function withNotificationServiceTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;

    // Idempotency — bail if a target with this name already exists.
    const existingTarget = project.pbxNativeTargetSection?.() || {};
    for (const key of Object.keys(existingTarget)) {
      const t = existingTarget[key];
      if (t && typeof t === 'object' && t.name === EXT_NAME) return cfg;
    }

    // Group + files
    const group = project.addPbxGroup(
      ['NotificationService.swift', 'Info.plist', `${EXT_NAME}.entitlements`],
      EXT_NAME,
      EXT_NAME,
      '"<group>"'
    );
    const rootGroup = project.getFirstProject()['firstProject']['mainGroup'];
    project.addToPbxGroup(group.uuid, rootGroup);

    // Target
    const target = project.addTarget(
      EXT_NAME,
      'app_extension',
      EXT_NAME,
      EXT_BUNDLE_ID
    );

    // Sources
    project.addBuildPhase(
      ['NotificationService.swift'],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid
    );

    // Frameworks — UserNotifications
    project.addBuildPhase(
      ['UserNotifications.framework'],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid
    );

    // Locate the main app target by product type — robust against share /
    // broadcast extensions being inserted earlier in the targets list.
    let mainAppTargetUuid = null;
    const nativeTargets = project.pbxNativeTargetSection() || {};
    for (const key of Object.keys(nativeTargets)) {
      const t = nativeTargets[key];
      if (t && typeof t === 'object' && t.productType === '"com.apple.product-type.application"') {
        const uuid = key.replace(/_comment$/, '');
        if (!/^[A-F0-9]+$/i.test(uuid)) continue;
        mainAppTargetUuid = uuid;
        break;
      }
    }
    if (!mainAppTargetUuid) {
      console.warn('[with-notification-service] No app-type target found — falling back to getFirstTarget');
      mainAppTargetUuid = project.getFirstTarget().uuid;
    }
    // Embed appex into the main app bundle
    project.addBuildPhase(
      [],
      'PBXCopyFilesBuildPhase',
      'Embed App Extensions',
      mainAppTargetUuid,
      'app_extension'
    );

    // [2026-05-18 fix] Register the NSE as a build dependency of the main
    // app target. Without this PBXTargetDependency entry, CocoaPods scans
    // the .pbxproj for embed relations, fails to find one, and aborts with
    //   "[!] Unable to find host target(s) for ChatyyNotificationService.
    //    Please add the host targets for the embedded targets to the Podfile."
    // The Podfile nested-target syntax alone is not enough — CocoaPods also
    // walks the Xcode project graph to infer hosts. Mirror what `addTarget`
    // does for first-class targets.
    try {
      project.addTargetDependency(mainAppTargetUuid, [target.uuid]);
    } catch (e) {
      console.warn('[with-notification-service] addTargetDependency failed:', e?.message || e);
    }

    // Build settings — entitlements, Info.plist, deployment target, etc.
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

// Insert a Podfile target block (inherits :search_paths so we don't drag
// all the main app's pods into the extension). NSE only needs Foundation +
// UserNotifications which are system frameworks — no pod deps strictly
// required — but defining the target keeps `pod install` consistent in
// case anyone adds a pod dep later.
function withNotificationServicePodTarget(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) return cfg;
      let pod = fs.readFileSync(podfilePath, 'utf8');
      const marker = `target '${EXT_NAME}' do`;
      if (pod.includes(marker)) return cfg;

      // Find `target 'Chatyy' do` then walk to its matching `end`, then
      // splice our nested target right before. Same heuristic as the
      // broadcast plugin — kept in lockstep.
      const lines = pod.split('\n');
      let chatyyLine = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*target\s+['"]Chatyy['"]\s+do\b/.test(lines[i])) { chatyyLine = i; break; }
      }
      if (chatyyLine === -1) {
        // Fall back to plain top-level append — better to compile than to skip.
        pod += `\n\ntarget '${EXT_NAME}' do\n  platform :ios, '15.0'\nend\n`;
        fs.writeFileSync(podfilePath, pod);
        return cfg;
      }
      let depth = 1;
      let endLine = -1;
      for (let i = chatyyLine + 1; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line.replace(/^\s+/, '');
        if (/\bdo\b(\s*\|[^|]*\|)?\s*$/.test(line)) depth++;
        else if (/^(if|unless|case|def|class|module|begin|while|until|for)\b/.test(stripped)
                 && !/\b(if|unless|while|until)\s+\w+\s*[<>=!]/.test(line)) depth++;
        if (/^end\b/.test(stripped)) {
          depth--;
          if (depth === 0) { endLine = i; break; }
        }
      }
      if (endLine === -1) {
        pod += `\n\ntarget '${EXT_NAME}' do\n  platform :ios, '15.0'\nend\n`;
        fs.writeFileSync(podfilePath, pod);
        return cfg;
      }
      const nested = [
        `  # Auto-injected NSE (notification service extension) target.`,
        `  # Inherits :search_paths so we don't link the main app's heavy pods.`,
        `  target '${EXT_NAME}' do`,
        `    inherit! :search_paths`,
        `    platform :ios, '15.0'`,
        `  end`,
      ];
      lines.splice(endLine, 0, ...nested);
      fs.writeFileSync(podfilePath, lines.join('\n'));
      return cfg;
    },
  ]);
}

module.exports = function withNotificationService(config) {
  config = withNotificationServiceFiles(config);
  config = withMainAppGroup(config);
  config = withNotificationServiceTarget(config);
  config = withNotificationServicePodTarget(config);
  return config;
};
